import { checks } from "./checks";

declare const process: { env: Record<string, string | undefined> };

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}. Use a test app with no real users: see CONTRIBUTING.md.`);
  return value;
};

checks("a real SweatStack", () => ({
  url: required("SWEATSTACK_URL").replace(/\/$/, ""),
  appId: required("SWEATSTACK_APP_ID"),
  clientSecret: required("SWEATSTACK_CLIENT_SECRET"),
  fetch: (input, init) => fetch(input, init),
}));
