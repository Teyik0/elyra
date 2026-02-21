import Elysia, { t } from "elysia";
import { queries, type User } from "../db";

export const authPlugin = new Elysia({ name: "auth" })
  .macro("isAuthenticated", {
    resolve({ cookie: { session } }) {
      const token = session?.value;

      if (!token || typeof token !== "string") {
        return { user: null as User | null, isAuthenticated: false };
      }

      const user = queries.getUserByEmail.get(token);

      if (!user) {
        return { user: null as User | null, isAuthenticated: false };
      }

      return { user, isAuthenticated: true };
    },
  })
  .macro("requireAuth", {
    isAuthenticated: true,
    resolve: ({ user, isAuthenticated, status }) => {
      if (!(isAuthenticated && user)) {
        return status(401, { error: "Unauthorized" });
      }
      return { user };
    },
  })
  .get(
    "/api/me",
    ({ user, isAuthenticated }) => {
      if (!(isAuthenticated && user)) {
        return { user: null };
      }
      return {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
        },
      };
    },
    { isAuthenticated: true }
  )
  .post(
    "/api/login",
    ({ body: { email }, cookie: { session } }) => {
      const user = queries.getUserByEmail.get(email);
      if (!user) {
        return { success: false, error: "Utilisateur non trouve" };
      }
      if (session) {
        session.value = email;
        session.httpOnly = true;
        session.maxAge = 7 * 86_400;
        session.path = "/";
      }
      return {
        success: true,
        user: { id: user.id, name: user.name, role: user.role },
      };
    },
    {
      body: t.Object({
        email: t.String(),
      }),
    }
  )
  .post("/api/logout", ({ cookie: { session } }) => {
    if (session) {
      session.value = "";
      session.maxAge = 0;
    }
    return { success: true };
  });
