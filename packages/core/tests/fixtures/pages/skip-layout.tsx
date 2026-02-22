import { route } from "./root";

export default route.page({
  component: () => <div data-testid="skip-page">Skip Layout Page (uses root directly)</div>,
});
