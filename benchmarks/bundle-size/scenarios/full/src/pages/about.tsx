import { route } from "./root";

export default route.page({
  staticParams: () => [{ id: "1" }, { id: "2" }],
  component: () => <div>About</div>,
});
