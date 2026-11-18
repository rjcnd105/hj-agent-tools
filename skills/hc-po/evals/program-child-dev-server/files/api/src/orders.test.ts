import { expect, test } from "bun:test";
import { listOrders } from "./orders";
test("lists orders", () => expect(listOrders()).toEqual([]));
