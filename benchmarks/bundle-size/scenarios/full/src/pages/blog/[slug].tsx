import { route } from "../root";

export default route.page({
  component: ({ params }) => <div>Blog: {params.slug}</div>,
});
