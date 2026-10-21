/** The product name shown to users (window title, tray, installer). */
export const APP_NAME = "QuoteBridge for MetaTrader";

/** Windows AppUserModelID: groups the app's notifications and taskbar entry (the installer uses the same). */
export const APP_USER_MODEL_ID = "QuoteBridge";

/** ADR 1: shown in the About box and the installer; the app claims no affiliation with MetaQuotes. */
export const TRADEMARK_NOTICE = "MetaTrader is the registered trademark of MetaQuotes Ltd.";

/** Where the source code lives (MIT; the bundled libzmq source pointer refers to it too). */
export const SOURCE_URL = "https://github.com/ross-jill-ws/quotebridge";

/** The About box text for the given app version. */
export function aboutText(version: string): { title: string; message: string; detail: string } {
  return {
    title: `About ${APP_NAME}`,
    message: APP_NAME,
    detail: [
      `Version ${version}`,
      "",
      `Open source under the MIT License: ${SOURCE_URL}`,
      "Bundles libzmq (MPL-2.0, built from unmodified upstream source) for the QuoteBridge EA.",
      "",
      TRADEMARK_NOTICE,
      `${APP_NAME} is an independent project, not affiliated with or endorsed by MetaQuotes Ltd.`,
    ].join("\n"),
  };
}
