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
