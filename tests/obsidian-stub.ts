export const Platform = {
  isWin: false,
  isMacOS: false,
  isLinux: false,
  isAndroidApp: false,
  isIosApp: false,
  isDesktopApp: true,
  isMobile: false
};

export const requestUrl = (): never => {
  throw new Error("requestUrl is not available in unit tests; inject a test transport.");
};

export const normalizePath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");

export class TFile {
  path = "";
  stat = { ctime: 0, mtime: 0, size: 0 };
}

export class TFolder {
  path = "";
  children: unknown[] = [];
}
