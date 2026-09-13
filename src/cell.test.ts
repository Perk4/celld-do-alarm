import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertPersist,
  createCell,
  getSetState,
  scheduleAlarm,
} from "./cell.ts";

test("createCell then getSetState returns the merged state", () => {
  const video = createCell("video:42", {
    views: 0,
    status: "idle",
  });
  assert.deepEqual(getSetState(video, { views: 1 }), {
    views: 1,
    status: "idle",
  });
});

test("second createCell on the same id ignores a different initialState", () => {
  const first = createCell("account:ada", {
    visits: 0,
    theme: "light",
  });
  assert.deepEqual(getSetState(first, { visits: 4, theme: "dark" }), {
    visits: 4,
    theme: "dark",
  });
  const reopened = createCell("account:ada", {
    visits: 999,
    theme: "light",
  });
  assert.deepEqual(getSetState(reopened, {}), {
    visits: 4,
    theme: "dark",
  });
});

test("second scheduleAlarm replaces the first", () => {
  const cell = createCell("account:ada-alarms", {
    visits: 0,
    theme: "light",
  });
  scheduleAlarm(cell, 1_800_000_000_000, { kind: "send-summary" });
  scheduleAlarm(cell, 1_800_000_060_000, {
    kind: "send-summary",
    attempt: 2,
  });
  assert.deepEqual(getSetState(cell, {}), {
    visits: 0,
    theme: "light",
  });

  const survived = assertPersist({
    id: "account:ada-alarms-persist",
    initialState: { visits: 0, theme: "light" },
    patch: { visits: 4, theme: "dark" },
    atMs: 1_800_000_060_000,
    payload: { kind: "send-summary", attempt: 2 },
  });
  assert.deepEqual(survived.alarm, {
    atMs: 1_800_000_060_000,
    payload: { kind: "send-summary", attempt: 2 },
  });
});

test("assertPersist returns survived state and alarm after restart", () => {
  const survived = assertPersist({
    id: "inbox:user-9",
    initialState: { unread: 0, lastFrom: "" },
    patch: { unread: 3, lastFrom: "ada" },
    atMs: 1_700_000_000_000,
    payload: { reason: "digest" },
  });
  assert.deepEqual(survived.state, { unread: 3, lastFrom: "ada" });
  assert.deepEqual(survived.alarm, {
    atMs: 1_700_000_000_000,
    payload: { reason: "digest" },
  });

  const leaked = createCell("inbox:user-9", { unread: 0, lastFrom: "" });
  assert.deepEqual(getSetState(leaked, {}), { unread: 0, lastFrom: "" });
});
