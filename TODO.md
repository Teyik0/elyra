# Roadmap Elysion

## Error Handling
- [ ] Error Boundaries - Support de `error.tsx` équivalent Next.js
- [ ] Not Found - Support de `not-found.tsx`

## Loading & Navigation
- [ ] Loading states - Support de `loading.tsx` / Suspense UI
- [ ] Pending states - UI de chargement pendant la navigation
- [ ] useRouter / useRoute - Hooks client-side pour navigation programmatique
- [ ] Link prefetching - Pré-chargement des routes au hover/visible
- [ ] SPA Navigation - Après le premier SSR/ISR, navigation en SPA sans reload

## Prefetching
- [ ] Prefetching strategy - Contrôle du prefetch (configurable par route)
- [ ] Prefetch on hover - Charger les données au survol du Link
- [ ] Prefetch on visible - Charger les données quand le Link entre dans le viewport

## React Server Components (RSC)

### Basics
- [ ] Support des Server Components (composants `async`)
- [ ] Streaming SSR avec Suspense
- [ ] Server-only code isolation (pas de leakage vers client)

### Data Fetching
- [ ] `use server` directive pour Server Actions
- [ ] Streaming data avec `use` hook
- [ ] Preload/await$data patterns

### Advanced
- [ ] Partial Prerendering (PPR)
- [ ] Server Components dans les layouts
- [ ] Client Components dans Server Components (composition)
- [ ] Dynamic imports de Server Components

## SPA Mode

### Hydration
- [ ] Selective Hydration - Hydrater seulement ce qui est interactif
- [ ] Lazy hydration - Hyddater les composants à la demande
- [ ] Island architecture - Zones statiques sans hydrate

### Navigation
- [ ] Client-side routing - Navigation sans reload
- [ ] Route transitions - Animations de transition
- [ ] Scroll restoration - Garder la position de scroll
- [ ] History management - Gestion de l'historique (back/forward)

### State
- [ ] Client cache - Cache partagé entre pages (comme TanStack Query)
- [ ] Optimistic updates - Mise à jour optimiste des données
- [ ] Prefetch cache - Stocker les données préchargées

## API Routes
- [ ] Route Handlers - `route.ts` pour endpoints REST
- [ ] Request/Response helpers
- [ ] API middleware

## Server Actions
- [ ] `use server` - Fonctions appelée depuis le client
- [ ] Form actions - Mutation de données via form
- [ ] Optimistic UI - Mise à jour immédiate du UI

## Middleware
- [ ] Global middleware
- [ ] Route-specific middleware
- [ ] Auth/redirect handling

## Optimizations
- [ ] Image optimization
- [ ] Font optimization
- [ ] Bundle analysis
- [ ] Code splitting automatique

## Developer Experience
- [ ] Parallel routes
- [ ] Intercepting routes
- [ ] i18n support
- [ ] CSS/Tailwind integration renforcée
