import { FakeSweatStack } from "../fakes/sweatstack";
import { network } from "../support/network";
import { checks } from "./checks";

const fake = new FakeSweatStack();

checks("the fake", () => ({
  url: fake.url,
  appId: fake.appId,
  clientSecret: fake.clientSecret,
  fetch: network({ [new URL(fake.url).host]: fake.fetch }),
}));
