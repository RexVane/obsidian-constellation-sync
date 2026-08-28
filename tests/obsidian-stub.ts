export const requestUrl = (): never => {
  throw new Error("requestUrl is not available in unit tests; inject a test transport.");
};
