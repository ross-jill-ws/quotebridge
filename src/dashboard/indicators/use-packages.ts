// The indicator packages the server has, for the Charts view's menu and legend and the Indicators page: fetched when
// the live connection opens, and again when the server says the packages, or whether they are enabled, changed.
import { useEffect, useMemo, useState } from "preact/hooks";
import { get } from "../api.js";
import type { PackageInfo } from "../charts/indicators.js";
import type { Live } from "../use-live.js";

export type PackageList = {
  /** This session may enable and disable packages: the app window's, not a remote browser's. */
  manage: boolean;
  packages: PackageInfo[];
};

export type Packages = {
  /** Undefined until the first list is in. */
  list?: PackageList;
  byId: ReadonlyMap<string, PackageInfo>;
  /** Puts in a list the server answered (after a change), before the notice comes. */
  set: (list: PackageList) => void;
  /** Fetches the list again (the charts using each package change with no notice). */
  refresh: () => void;
};

export function usePackages(live: Live): Packages {
  const [list, setList] = useState<PackageList>();
  const [reload, setReload] = useState(0);
  useEffect(() => live.onPackages(() => setReload((n) => n + 1)), []);
  useEffect(() => {
    if (live.status !== "live") return;
    let current = true;
    get<PackageList>("/api/indicators/packages").then(
      (answer) => current && setList(answer),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [live.status, reload]);
  const byId = useMemo(() => new Map((list?.packages ?? []).map((p) => [p.manifest.id, p])), [list]);
  return { list, byId, set: setList, refresh: () => setReload((n) => n + 1) };
}
