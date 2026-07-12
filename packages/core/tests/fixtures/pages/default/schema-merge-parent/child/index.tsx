import { route } from "./_route";

export default route.page({
  component: ({ query }) => (
    <div data-testid="schema-merge-page">
      <span data-testid="parent-filter">
        {String((query as { parentFilter?: string }).parentFilter)}
      </span>
      <span data-testid="child-filter">
        {String((query as { childFilter?: string }).childFilter)}
      </span>
    </div>
  ),
});
