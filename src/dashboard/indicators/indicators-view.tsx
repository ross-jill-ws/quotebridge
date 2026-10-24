// The Indicators page: every indicator package the app has, with its version, whether it is bundled, whether it is
// enabled and how many charts use it; a package opens on its README, licence, parameters and outputs. Only the app
// window installs (from a ZIP picked or dropped on the page, previewed first), enables, disables or deletes packages
// (ADR 12); a remote browser sees the page read-only.
import { useEffect, useRef, useState } from "preact/hooks";
import { get, post, postZip } from "../api.js";
import type { Manifest } from "../../shared/indicator-manifest.js";
import type { Live } from "../use-live.js";
import { packageDetails, packageRows, previewChanges, readmeBlocks, type Block, type Inline } from "./indicators-model.js";
import { usePackages, type PackageList } from "./use-packages.js";

/** How often the charts each package is used by are read again. */
const CHARTS_REFRESH_MS = 5000;

/** A package ZIP as /api/indicators/packages/preview answers it. */
type PreviewAnswer = { manifest: Manifest; hash: string; readme: string; licence: string; replaces: { manifest: Manifest; hash: string } | null; downgrade: boolean };

export function IndicatorsView({ live }: { live: Live }) {
  const { list, set, refresh } = usePackages(live);
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [preview, setPreview] = useState<{ zip: Blob; answer: PreviewAnswer }>();
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // The charts using a package are counted by the windows that report them, with no notice: read again now and then.
  useEffect(() => {
    const timer = setInterval(refresh, CHARTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const manage = list?.manage === true;

  const fail = (e: Error) => {
    setError(e.message);
    setDone("");
  };
  const switchTo = (id: string, enabled: boolean) =>
    post<PackageList>("/api/indicators/packages/enabled", { id, enabled }).then((answer) => {
      set(answer);
      setError("");
    }, fail);

  /** Checks a ZIP and shows what it is; nothing is installed yet. */
  const previewZip = (zip: Blob) => {
    setBusy(true);
    setPreview(undefined);
    postZip<PreviewAnswer>("/api/indicators/packages/preview", zip)
      .then((answer) => {
        setPreview({ zip, answer });
        setError("");
        setDone("");
      }, fail)
      .finally(() => setBusy(false));
  };
  const install = (downgrade: boolean) => {
    if (!preview) return;
    const { manifest } = preview.answer;
    setBusy(true);
    postZip<PackageList>(`/api/indicators/packages/install${downgrade ? "?downgrade=1" : ""}`, preview.zip)
      .then((answer) => {
        set(answer);
        setPreview(undefined);
        setError("");
        setDone(`${manifest.name} ${manifest.version} is installed.`);
        setOpen(manifest.id);
      }, fail)
      .finally(() => setBusy(false));
  };
  const remove = (id: string) =>
    post<PackageList>("/api/indicators/packages/delete", { id }).then((answer) => {
      const name = list?.packages.find((p) => p.manifest.id === id)?.manifest.name ?? id;
      set(answer);
      setOpen(undefined);
      setError("");
      setDone(`${name} is deleted.`);
    }, fail);

  const files = (e: DragEvent) => e.dataTransfer?.types.includes("Files") === true;
  const rows = list ? packageRows(list.packages) : [];
  return (
    <section
      class={`view indicators${dropping ? " dropping" : ""}`}
      aria-labelledby="indicators-title"
      onDragOver={(e) => {
        if (!manage || !files(e)) return;
        e.preventDefault();
        e.dataTransfer!.dropEffect = "copy";
        setDropping(true);
      }}
      onDragLeave={(e) => {
        // Only when the pointer leaves the page, not as it crosses from one element to another.
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!manage || !files(e)) return;
        e.preventDefault();
        setDropping(false);
        const zip = e.dataTransfer!.files[0];
        if (zip) previewZip(zip);
      }}
    >
      <div class="indicators-head">
        <div>
          <h1 id="indicators-title">Indicators</h1>
          <p class="lead">The indicator packages the charts can draw. Bundled packages ship with the app and update with it.</p>
        </div>
        {manage && (
          <div class="install-action">
            <button class="button primary" disabled={busy} onClick={() => picker.current?.click()}>
              Install package…
            </button>
            <span class="muted">or drop a ZIP on this page</span>
            <input
              ref={picker}
              type="file"
              accept=".zip,application/zip"
              hidden
              onChange={(e) => {
                const input = e.target as HTMLInputElement;
                const zip = input.files?.[0];
                // The same file picked again is a change too.
                input.value = "";
                if (zip) previewZip(zip);
              }}
            />
          </div>
        )}
      </div>
      {list && !manage && (
        <div class="notice" role="status">
          <span class="dot" aria-hidden="true" />
          <span>
            <strong>Read only.</strong> Only the app window can install, enable, disable or delete packages.
          </span>
        </div>
      )}
      {error && (
        <div class="notice bad" role="alert">
          <span class="dot" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}
      {done && !error && (
        <div class="notice good" role="status">
          <span class="dot" aria-hidden="true" />
          <span>{done}</span>
        </div>
      )}
      {busy && !preview && <p class="muted">Checking the package…</p>}
      {preview && <InstallPreview key={preview.answer.hash} answer={preview.answer} busy={busy} onInstall={install} onCancel={() => setPreview(undefined)} />}
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
                          disabled={!manage}
                          aria-label={`${row.name} enabled`}
                          title={manage ? (row.enabled ? `Disable ${row.name}` : `Enable ${row.name}`) : "Only the app window can change this"}
                          onChange={(e) => switchTo(row.id, (e.target as HTMLInputElement).checked)}
                        />
                      </td>
                    </tr>,
                    expanded && (
                      <tr key={`${row.id}-details`} class="package-details-row">
                        <td colSpan={5} id={`package-${row.id}`}>
                          <PackageDetailsPanel
                            id={row.id}
                            hash={pkg.hash}
                            manifest={pkg.manifest}
                            charts={row.charts}
                            onDelete={manage && !pkg.bundled ? () => remove(row.id) : undefined}
                          />
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
      {dropping && (
        <div class="drop-overlay" aria-hidden="true">
          <span>Drop the package ZIP to preview it</span>
        </div>
      )}
    </section>
  );
}

/**
 * A package ZIP, checked but not installed: what it is, what it replaces and what changes, its parameters, outputs,
 * README and licence. An older version than the one installed needs a second confirmation.
 */
function InstallPreview({ answer, busy, onInstall, onCancel }: { answer: PreviewAnswer; busy: boolean; onInstall: (downgrade: boolean) => void; onCancel: () => void }) {
  const { manifest, replaces, downgrade } = answer;
  const { action, changes } = previewChanges(manifest, replaces?.manifest ?? null, downgrade);
  const [older, setOlder] = useState(false);
  return (
    <section class="install-preview" aria-labelledby="install-preview-title" onKeyDown={(e) => e.key === "Escape" && onCancel()}>
      <header>
        <span class="tag neutral">Preview</span>
        <h2 id="install-preview-title">
          {action} {manifest.name} <span class="nowrap">{manifest.version}</span>
        </h2>
        <span class="package-id">{manifest.id}</span>
      </header>
      <p class="muted">Checked: the files, the manifest and a trial run in the sandbox. Nothing is installed until you confirm.</p>
      {replaces && (
        <div class="preview-changes">
          <h3>
            Replaces {replaces.manifest.name} {replaces.manifest.version}
          </h3>
          <ul>
            {changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          {action === "Upgrade" || action === "Downgrade" ? <p class="muted">Charts using it keep the parameters that still exist; new ones take their defaults.</p> : null}
        </div>
      )}
      {downgrade && (
        <label class="notice warn downgrade-confirm">
          <input type="checkbox" checked={older} onChange={(e) => setOlder((e.target as HTMLInputElement).checked)} />
          <span>
            <strong>This is an older version</strong> than the {replaces!.manifest.version} installed. Install it anyway.
          </span>
        </label>
      )}
      <div class="package-details">
        <PackageInfoPanel manifest={manifest} files={{ readme: answer.readme, licence: answer.licence }} licenceOpen />
      </div>
      <div class="confirm-actions">
        <button class="button primary" disabled={busy || (downgrade && !older)} onClick={() => onInstall(downgrade)}>
          {action === "Reinstall" ? "Install again" : action}
        </button>
        <button class="button quiet" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** A package's parameters and outputs, then its README and licence (read when it opens), and Delete for an installed one. */
function PackageDetailsPanel({ id, hash, manifest, charts, onDelete }: { id: string; hash?: string; manifest: Manifest; charts: number; onDelete?: () => Promise<void> }) {
  const [files, setFiles] = useState<{ readme: string; licence: string }>();
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    get<{ readme: string; licence: string }>(`/api/indicators/package?id=${encodeURIComponent(id)}`).then(setFiles, (e: Error) => setError(e.message));
  }, [id, hash]);
  const used = charts === 0 ? "" : ` ${charts === 1 ? "The chart using it shows" : `The ${charts} charts using it show`} it as Not available until it is installed again.`;
  return (
    <div class="package-details">
      <PackageInfoPanel manifest={manifest} files={files} />
      {error && <p class="bad-text">{error}</p>}
      {onDelete && (
        <div class="package-actions">
          {confirming ? (
            <div class="confirm" role="alertdialog" aria-label={`Delete ${manifest.name}?`} onKeyDown={(e) => e.key === "Escape" && setConfirming(false)}>
              <strong>Delete {manifest.name}?</strong>
              <p>The package is removed from the app.{used || " Charts that use it show it as Not available until it is installed again."}</p>
              <div class="confirm-actions">
                <button
                  class="button danger"
                  autoFocus
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    onDelete().finally(() => setBusy(false));
                  }}
                >
                  Delete package
                </button>
                <button class="button quiet" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button class="button quiet" onClick={() => setConfirming(true)}>
              Delete…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** What a package is: its description, parameters and outputs, then its README and licence once they are in. */
function PackageInfoPanel({ manifest, files, licenceOpen = false }: { manifest: Manifest; files?: { readme: string; licence: string }; licenceOpen?: boolean }) {
  const details = packageDetails(manifest);
  return (
    <>
      <p class="package-description">{manifest.description}</p>
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
      {files && (
        <>
          <article class="readme" aria-label="README">
            {readmeBlocks(files.readme).map((block, i) => (
              <ReadmeBlock key={i} block={block} />
            ))}
          </article>
          <details class="licence" open={licenceOpen}>
            <summary>Licence</summary>
            <pre>{files.licence}</pre>
          </details>
        </>
      )}
    </>
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
