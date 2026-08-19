import { useEffect, useState } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { authClient } from "@contentgrowth/content-auth";
import { Spinner } from "./ui";

export function ProtectedRoute() {
  const location = useLocation();
  const [status, setStatus] = useState<"loading" | "authed" | "guest">("loading");

  useEffect(() => {
    let alive = true;
    authClient
      .getSession()
      .then(({ data }) => {
        if (alive) setStatus(data?.session ? "authed" : "guest");
      })
      .catch(() => alive && setStatus("guest"));
    return () => {
      alive = false;
    };
  }, []);

  if (status === "loading") {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner label="Checking session…" />
      </div>
    );
  }
  if (status === "guest") {
    return <Navigate to="/signin" replace state={{ from: location }} />;
  }
  return <Outlet />;
}