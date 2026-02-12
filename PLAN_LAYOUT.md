# Plan Refonte Types Core - Elysion Layout System

## Vision

Implémenter un système de layouts imbriqués avec héritage de données et validation des params/query centralisée, offrant une DX moderne et cohérente entre `layout()` et `page()`.

---

## 1. Structure des Fichiers Détectés

```
src/
├── pages/
│   ├── layout.tsx              # Root layout
│   ├── page.tsx                # Home page
│   ├── route.ts                # Validation route-level (optionnel)
│   │
│   └── blog/
│       ├── layout.tsx          # Blog layout (imbriqué)
│       ├── page.tsx            # Blog index
│       ├── route.ts            # Validation pour /blog/*
│       │
│       └── [slug]/
│           ├── layout.tsx      # Post layout
│           ├── page.tsx        # Post page
│           └── route.ts        # Validation pour /blog/:slug
```

---

## 2. Interface `route()` - Validation Centralisée

### Objectif
Centraliser la validation des params et query string au niveau de la route, pas dans les composants.

### Interface

```typescript
// route.ts pour /blog/[slug]
export default route({
  params: t.Object({ 
    slug: t.String() 
  }),
  query: t.Object({ 
    search: t.Optional(t.String()),
    page: t.Optional(t.Number())
  }),
  // Métadonnées route-level
  meta: { 
    auth: true,
    revalidate: 3600 
  }
});
```

### Règles
- Un seul `route.ts` par niveau de répertoire
- Hérite implicitement des validations parentes (merge des schémas)
- Les layouts et pages enfant accèdent aux params/query validés sans redéfinir

---

## 3. Interface `layout()` - Layouts Imbriqués

### Signature

```typescript
export interface LayoutContext<
  TParams extends Record<string, string>,
  TQuery extends Record<string, unknown>,
  TParentData extends Record<string, unknown>
> {
  params: TParams;           // Validés par route.ts
  query: TQuery;             // Validés par route.ts
  parentData: TParentData;   // Données des layouts parents
}

export interface LayoutOptions<
  TData extends Record<string, unknown>,
  TParams extends Record<string, string>,
  TQuery extends Record<string, unknown>,
  TParentData extends Record<string, unknown>
> {
  loader?: (ctx: LayoutContext<TParams, TQuery, TParentData>) => 
    Promise<TData> | TData;
  
  head?: (ctx: { 
    params: TParams; 
    query: TQuery; 
    data: TData; 
    parentData: TParentData;
  }) => HeadOptions;
  
  component: React.FC<
    TData & { 
      children: React.ReactNode;
      params: TParams;
      query: TQuery;
    }
  >;
  
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number | false;
}

export function layout<
  TData extends Record<string, unknown>,
  TParams extends Record<string, string> = Record<string, never>,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
  TParentData extends Record<string, unknown> = Record<string, never>
>(props: LayoutOptions<TData, TParams, TQuery, TParentData>): LayoutModule;
```

### Exemple Usage

```typescript
// /layout.tsx - Root layout
export default layout({
  loader: async ({ query }) => ({
    theme: query.theme ?? 'light',
    user: await getCurrentUser()
  }),
  component: ({ children, theme, user, params, query }) => (
    <html data-theme={theme}>
      <body>
        <Header user={user} />
        {children}
        <Footer />
      </body>
    </html>
  )
});

// /blog/layout.tsx - Layout imbriqué
export default layout({
  loader: async ({ params, query, parentData }) => {
    // parentData = { theme: string, user: User }
    return {
      categories: await getCategories()
    };
  },
  component: ({ children, categories, theme, user, params, query }) => (
    <div className="blog-layout">
      <Sidebar categories={categories} />
      <main>{children}</main>
    </div>
  )
});
```

---

## 4. Interface `page()` - Page Finale

### Signature Modifiée

```typescript
export interface PageOptions<
  TData extends Record<string, unknown>,
  TParams extends Record<string, string>,
  TQuery extends Record<string, unknown>,
  TParentData extends Record<string, unknown>
> {
  loader?: (ctx: {
    params: TParams;
    query: TQuery;
    parentData: TParentData;  // Toutes les données des layouts parents
  }) => Promise<TData> | TData;
  
  head?: (ctx: {
    params: TParams;
    query: TQuery;
    data: TData;
    parentData: TParentData;
  }) => HeadOptions;
  
  component: React.FC<TData & TParentData>;  // Merge automatique
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number | false;
}

export function page<
  TData extends Record<string, unknown>,
  TParams extends Record<string, string> = Record<string, never>,
  TQuery extends Record<string, unknown> = Record<string, unknown>,
  TParentData extends Record<string, unknown> = Record<string, never>
>(props: PageOptions<TData, TParams, TQuery, TParentData>): PageModule;
```

### Exemple Usage

```typescript
// /blog/[slug]/page.tsx
export default page({
  loader: async ({ params, query, parentData }) => {
    // params: { slug: string } - validé par route.ts
    // query: { search?: string, page?: number } - validé par route.ts
    // parentData: { theme: string, user: User, categories: Category[] }
    
    return {
      post: await getPost(params.slug),
      related: await getRelatedPosts(params.slug)
    };
  },
  
  head: ({ params, data }) => ({
    title: data.post.title,
    meta: [{ name: "description", content: data.post.excerpt }]
  }),
  
  component: ({ 
    // Données du loader page
    post, related,
    // Données héritées des layouts
    theme, user, categories,
    // Params/query accessibles si besoin
    params, query
  }) => (
    <article>
      <h1>{post.title}</h1>
      <Author user={user} />
      <Content post={post} />
      <Related posts={related} />
    </article>
  )
});
```

---

## 5. Résolution des Données (Runtime)

### Algorithme

```typescript
async function resolveRouteData(path: string, context: RequestContext) {
  // 1. Récupérer la chaîne de layouts
  const layouts = getLayoutChain(path); // [rootLayout, blogLayout]
  const page = getPage(path);
  
  // 2. Valider params/query une seule fois avec schéma mergé
  const routeConfig = mergeRouteConfigs(path);
  const validated = await validate(context, routeConfig);
  
  // 3. Exécuter les loaders en cascade
  let parentData: Record<string, unknown> = {};
  const layoutData: Record<string, unknown>[] = [];
  
  for (const layout of layouts) {
    if (layout.loader) {
      const data = await layout.loader({
        params: validated.params,
        query: validated.query,
        parentData
      });
      
      parentData = { ...parentData, ...data };
      layoutData.push(data);
    }
  }
  
  // 4. Exécuter le loader de la page
  const pageData = page.loader 
    ? await page.loader({
        params: validated.params,
        query: validated.query,
        parentData
      })
    : {};
  
  // 5. Merger toutes les données pour le rendu
  const mergedData = { ...parentData, ...pageData };
  
  return {
    layoutData,
    pageData,
    mergedData,
    params: validated.params,
    query: validated.query
  };
}
```

---

## 6. Rendu Imbriqué

```typescript
function renderWithLayouts(
  layouts: LayoutModule[],
  page: PageModule,
  data: ResolvedData
) {
  // Commencer par la page (niveau le plus profond)
  let element = <page.component {...data.mergedData} />;
  
  // Wrapper avec chaque layout en remontant
  for (let i = layouts.length - 1; i >= 0; i--) {
    const layout = layouts[i];
    const layoutProps = {
      ...data.layoutData[i],
      ...data.parentData,  // Toutes les données parentes
      params: data.params,
      query: data.query,
      children: element
    };
    
    element = <layout.component {...layoutProps} />;
  }
  
  return renderToString(element);
}
```

---

## 7. Types Support

```typescript
// Brand types pour la vérification runtime
export interface LayoutModule<
  TData = Record<string, unknown>
> {
  __brand: "ELYSION_REACT_LAYOUT";
  loader?: Function;
  head?: Function;
  component: React.FC<any>;
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number | false;
}

export interface PageModule<
  TData = Record<string, unknown>
> {
  __brand: "ELYSION_REACT_PAGE";
  loader?: Function;
  head?: Function;
  component: React.FC<any>;
  mode?: "ssr" | "ssg" | "isr";
  revalidate?: number | false;
}

export interface RouteModule {
  __brand: "ELYSION_ROUTE_CONFIG";
  params?: AnySchema;
  query?: AnySchema;
  meta?: Record<string, unknown>;
}

// Guards runtime
export function isLayoutModule(value: unknown): value is LayoutModule;
export function isPageModule(value: unknown): value is PageModule;
export function isRouteModule(value: unknown): value is RouteModule;
```

---

## 8. Cache et Performance

### Stratégie

1. **Build time** : Scanner et pré-analyser toutes les routes
2. **Runtime** : 
   - Valider params/query une seule fois par requête
   - Cacher les résultats des loaders de layouts si `revalidate` défini
   - Support du streaming React 18+ pour les Suspense boundaries

### Exemple Cache Layout

```typescript
// /blog/layout.tsx
export default layout({
  loader: async ({ parentData }) => {
    return { categories: await getCategories() };
  },
  revalidate: 3600,  // Cache 1 heure
  component: ({ children, categories }) => (
    <BlogLayout categories={categories}>{children}</BlogLayout>
  )
});
```

---

## 9. Error Boundaries (Futur)

```typescript
// /blog/error.tsx
export default error({
  component: ({ error, reset }) => (
    <div className="error-boundary">
      <h1>Une erreur est survenue</h1>
      <button onClick={reset}>Réessayer</button>
    </div>
  )
});
```

---

## 10. Points Clés DX

1. **Cohérence** : `layout()` et `page()` partagent la même interface
2. **Typage** : TypeScript infère automatiquement les données héritées
3. **Validation** : Centralisée dans `route.ts`, pas de duplication
4. **Héritage** : Données des layouts automatiquement disponibles dans les enfants
5. **Mode** : SSR/SSG/ISR supporté à tous les niveaux

---

## 11. Ordre d'Implémentation

1. [ ] Définir les types de base (`LayoutModule`, `PageModule`, `RouteModule`)
2. [ ] Implémenter `route()` avec validation
3. [ ] Implémenter `layout()` avec héritage `parentData`
4. [ ] Modifier `page()` pour supporter `parentData`
5. [ ] Scanner les layouts et construire la chaîne
6. [ ] Implémenter la résolution des données
7. [ ] Implémenter le rendu imbriqué
8. [ ] Ajouter le système de cache
9. [ ] Tests et documentation
