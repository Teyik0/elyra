export class AutoInvalidateRegistry {
  private readonly pathToTags = new Map<string, Set<string>>();
  private readonly tagToPaths = new Map<string, Set<string>>();

  registerLoaderTags(urlPath: string, tags: readonly string[] | undefined): void {
    if (!tags || tags.length === 0) {
      this.unregisterPath(urlPath);
      return;
    }

    this.unregisterPath(urlPath);

    const uniqueTags = new Set(tags);
    this.pathToTags.set(urlPath, uniqueTags);
    for (const tag of uniqueTags) {
      let paths = this.tagToPaths.get(tag);
      if (!paths) {
        paths = new Set<string>();
        this.tagToPaths.set(tag, paths);
      }
      paths.add(urlPath);
    }
  }

  pathsForTags(tags: readonly string[]): string[] {
    const paths = new Set<string>();
    for (const tag of tags) {
      for (const path of this.tagToPaths.get(tag) ?? []) {
        paths.add(path);
      }
    }
    return [...paths];
  }

  unregisterPath(urlPath: string): void {
    const tags = this.pathToTags.get(urlPath);
    if (!tags) {
      return;
    }

    for (const tag of tags) {
      const paths = this.tagToPaths.get(tag);
      if (!paths) {
        continue;
      }
      paths.delete(urlPath);
      if (paths.size === 0) {
        this.tagToPaths.delete(tag);
      }
    }
    this.pathToTags.delete(urlPath);
  }

  reset(): void {
    this.pathToTags.clear();
    this.tagToPaths.clear();
  }
}

export const autoInvalidateRegistry = new AutoInvalidateRegistry();
