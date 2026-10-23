// The Indicators page: every indicator package the app has, with its version, whether it is bundled, whether it is
// enabled and how many charts use it; a package opens on its README, licence, parameters and outputs. Only the app
// window enables or disables packages (ADR 12); a remote browser sees the page read-only.
import { useEffect, useState } from "preact/hooks";
import { get, post } from "../api.js";
import type { Live } from "../use-live.js";
import { packageDetails, packageRows, readmeBlocks, type Block, type Inline } from "./indicators-model.js";
import { usePackages, type PackageList } from "./use-packages.js";

/** How often the charts each package is used by are read again. */
const CHARTS_REFRESH_MS = 5000;

export function IndicatorsView({ live }: { live: Live }) {
  const { list, set, refresh } = usePackages(live);
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState("");
  // The charts using a package are counted by the windows that report them, with no notice: read again now and then.
  useEffect(() => {
    const timer = setInterval(refresh, CHARTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const switchTo = (id: string, enabled: boolean) =>
    post<PackageList>("/api/indicators/packages/enabled", { id, enabled }).then(
      (answer) => {
        set(answer);
        setError("");
      },
      (e: Error) => setError(e.message),
    );

  const rows = list ? packageRows(list.packages) : [];
  return (
    <section class="view indicators" aria-labelledby="indicators-title">
      <h1 id="indicators-title">Indicators</h1>
      <p class="lead">The indicator packages the charts can draw. Bundled packages ship with the app and update with it.</p>
      {list && !list.manage && (
        <div class="notice" role="status">
          <span class="dot" aria-hidden="true" />
          <span>
            <strong>Read only.</strong> Only the app window can enable or disable packages.
          </span>
        </div>
      )}
      {error && (
        <div class="notice bad" role="alert">
          <span class="dot" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {!list ? (
        <p class="muted">Loading…</p>
      ) : (
        <section class="feed-group package-list" aria-label="Packages">
          <div class="table-scroll">
            <table class="history-table packages-table">
              <thead>
                <tr>
                  <th>Package</th>
                  <th>Version</th>
                  <th>Source</th>
                  <th title="Counted from the windows open now that report their charts">Charts using it</th>
                  <th class="enabled-col">Enabled</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const pkg = list.packages.find((p) => p.manifest.id === row.id)!;
                  const expanded = open === row.id;
                  return [
                    <tr key={row.id} class={`${expanded ? "open" : ""}${row.enabled ? "" : " off"}`}>
                      <td>
                        <button class="package-name" aria-expanded={expanded} aria-controls={`package-${row.id}`} onClick={() => setOpen(expanded ? undefined : row.id)}>
                          <svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">
                            <path d="M6 4l4 4-4 4" />
                          </svg>
                          {row.name}
                        </button>
                        <span class="package-id">{row.id}</span>
                      </td>
                      <td class="nowrap">{row.version}</td>
                      <td>
                        <span class={`tag ${row.origin === "Bundled" ? "neutral" : "good"}`}>{row.origin}</span>
                      </td>
                      <td class={row.charts === 0 ? "muted" : ""}>{row.chartsText}</td>
                      <td class="enabled-col">
                        <input
                          type="checkbox"
                          role="switch"
                          class="switch small"
                          checked={row.enabled}
                          disabled={!list.manage}
                          aria-label={`${row.name} enabled`}
                          title={list.manage ? (row.enabled ? `Disable ${row.name}` : `Enable ${row.name}`) : "Only the app window can change this"}
                          onChange={(e) => switchTo(row.id, (e.target as HTMLInputElement).checked)}
                        />
                      </td>
                    </tr>,
                    expanded && (
                      <tr key={`${row.id}-details`} class="package-details-row">
                        <td colSpan={5} id={`package-${row.id}`}>
                          <PackageDetailsPanel id={row.id} description={pkg.manifest.description} details={packageDetails(pkg.manifest)} />
                        </td>
                      </tr>
                    ),
                  ];
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p class="foot-note muted">Charts using it counts the charts in the windows open now, as they report them; it is approximate.</p>
    </section>
  );
}

/** A package's parameters and outputs, then its README and licence (read when it opens). */
function PackageDetailsPanel({ id, description, details }: { id: string; description: string; details: ReturnType<typeof packageDetails> }) {
  const [files, setFiles] = useState<{ readme: string; licence: string }>();
  const [error, setError] = useState("");
  useEffect(() => {
    get<{ readme: string; licence: string }>(`/api/indicators/package?id=${encodeURIComponent(id)}`).then(setFiles, (e: Error) => setError(e.message));
  }, [id]);
  return (
    <div class="package-details">
      <p class="package-description">{description}</p>
      <div class="package-facts">
        <div>
          <h3>Parameters</h3>
          {details.parameters.length === 0 ? (
            <p class="muted">None.</p>
          ) : (
            <table class="package-table">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th>Range</th>
                  <th>Default</th>
                </tr>
              </thead>
              <tbody>
                {details.parameters.map((p) => (
                  <tr key={p.label}>
                    <td>{p.label}</td>
                    <td>{p.range}</td>
                    <td>{p.default}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <h3>Outputs</h3>
          <table class="package-table">
            <thead>
              <tr>
                <th>Output</th>
                <th>Drawn as</th>
                <th>On</th>
              </tr>
            </thead>
            <tbody>
              {details.outputs.map((o) => (
                <tr key={o.label}>
                  <td>{o.label}</td>
                  <td>{o.kind}</td>
                  <td>{o.placement}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {error && <p class="bad-text">{error}</p>}
      {files && (
        <>
          <article class="readme" aria-label="README">
            {readmeBlocks(files.readme).map((block, i) => (
              <ReadmeBlock key={i} block={block} />
            ))}
          </article>
          <details class="licence">
            <summary>Licence</summary>
            <pre>{files.licence}</pre>
          </details>
        </>
      )}
    </div>
  );
}

function ReadmeBlock({ block }: { block: Block }) {
  switch (block.type) {
    case "heading": {
      // The page has its h1 and the panel its h3s: README headings start at h4.
      const Tag = `h${Math.min(6, block.level + 3)}` as "h4";
      return (
        <Tag>
          <Text runs={block.text} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p>
          <Text runs={block.text} />
        </p>
      );
    case "list":
      return (
        <ul>
          {block.items.map((item, i) => (
            <li key={i}>
              <Text runs={item} />
            </li>
          ))}
        </ul>
      );
    case "table":
      return (
        <div class="table-scroll">
          <table class="package-table">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i}>
                    <Text runs={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i}>
                      <Text runs={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "code":
      return <pre>{block.text}</pre>;
  }
}

function Text({ runs }: { runs: Inline[] }) {
  return (
    <>
      {runs.map((run, i) => (run.code ? <code key={i}>{run.text}</code> : run.bold ? <strong key={i}>{run.text}</strong> : run.text))}
    </>
  );
}
