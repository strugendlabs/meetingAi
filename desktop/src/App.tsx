import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import Onboarding from "./screens/Onboarding";
import Home from "./screens/Home";
import MeetingView from "./screens/MeetingView";
import Settings from "./screens/Settings";
import { getSettings, useSettings } from "./lib/settings";

/**
 * Minimal state-based router.
 *
 * Routes: onboarding | home | meeting/:id | settings.
 * Screens call `useRouter().navigate(...)` to change screens; the meeting
 * route carries the meeting id.
 */
export type Route =
  | { name: "onboarding" }
  | { name: "home" }
  | { name: "meeting"; meetingId: string }
  | { name: "settings" };

export interface Router {
  route: Route;
  navigate: (route: Route) => void;
}

const RouterContext = createContext<Router>({
  route: { name: "onboarding" },
  navigate: () => {},
});

export function useRouter(): Router {
  return useContext(RouterContext);
}

/** Initial route from persisted settings: home once onboarded, else onboarding. */
function initialRoute(): Route {
  return { name: getSettings().onboarded ? "home" : "onboarding" };
}

export default function App() {
  // With localStorage the settings store hydrates synchronously, so the
  // initial route is known immediately. Inside Tauri the plugin-store backend
  // is async: render nothing until hydration finishes, then pick the route.
  const [route, setRoute] = useState<Route | null>(() =>
    useSettings.persist.hasHydrated() ? initialRoute() : null,
  );

  useEffect(() => {
    if (route !== null) return;
    if (useSettings.persist.hasHydrated()) {
      setRoute(initialRoute());
      return;
    }
    return useSettings.persist.onFinishHydration(() => {
      setRoute((r) => r ?? initialRoute());
    });
  }, [route]);

  if (route === null) {
    return <div className="min-h-screen bg-white dark:bg-neutral-950" />;
  }

  let screen: ReactNode;
  switch (route.name) {
    case "onboarding":
      screen = <Onboarding />;
      break;
    case "home":
      screen = <Home />;
      break;
    case "meeting":
      screen = <MeetingView meetingId={route.meetingId} />;
      break;
    case "settings":
      screen = <Settings />;
      break;
  }

  return (
    <RouterContext.Provider value={{ route, navigate: setRoute }}>
      <div className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        {screen}
      </div>
    </RouterContext.Provider>
  );
}
