// ego-rec compile 6a1b2c3d: Shop checkout
// Run with `ego-rec test <file>` (stops before payment) or `ego-rec run <file>` (real payment).
const REC = "6a1b2c3d";
const SCRIPT = "shop-test-2c3d";
if (!globalThis.__egoRec) throw new Error("Run through `ego-rec test` or `ego-rec run`.");
const ARGS = globalThis.__egoRec.args;
const STOP_BEFORE_AT_MOST_ONCE = globalThis.__egoRec.stopBeforeAtMostOnce;
const EXT_ID = "hacjfebiagkihcmmobkiniihcclmlhpd";
const PARAMS = {
  // TODO(param) 수량 injected
  "qty": ARGS["qty"] ?? "2\"",
};
const START_INPUTS = ["login.password"];
const LOGIN = {"from":2,"to":3,"post_url":"https://shop.test/checkout"};
const TEST_STOP_STEP = 5;
const STEPS = [
  {"kind":"goto","n":1,"value":{"literal":"https://shop.test/login"}},
  {"kind":"fill","locators":["loc=css:#p"],"n":2,"value":{"secret":"login.password"}},
  {"expect":{"url":"https://shop.test/checkout"},"kind":"click","locators":["loc=role:button[name='Login']"],"n":3},
  {"kind":"fill","locators":["loc=css:#q"],"n":4,"value":{"param":"qty"}},
  {"at_most_once":true,"expect":{"response":{"id":"n9","method":"POST","url":"https://shop.test/api/charge"}},"kind":"click","locators":["loc=role:button[name='결제하기']"],"n":5},
];
