import { FakeSweatStack } from "../fakes/sweatstack";
import { network } from "../support/network";
import { checks } from "./checks";

// With write ticked for Wellness, as on a test app set up for the bridge's wellness.
const fake = new FakeSweatStack({ defaultScopes: ["activities:write", "wellness:write"] });

checks("the fake", () => ({
  url: fake.url,
  appId: fake.appId,
  clientSecret: fake.clientSecret,
  fetch: network({ [new URL(fake.url).host]: fake.fetch }),
}));
