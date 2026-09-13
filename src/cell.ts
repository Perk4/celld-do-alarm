import assert from "node:assert/strict";

type DurablePrimitive = null | boolean | number | string;

export type DurableValue =
  | DurablePrimitive
  | readonly DurableValue[]
  | Readonly<Record<string, DurableValue>>;

export type DurableState = Readonly<Record<string, DurableValue>>;

export type Patch<State extends DurableState> = {
  readonly [Key in keyof State]?: State[Key];
};

declare const cellStateBrand: unique symbol;

export type Cell<State extends DurableState = DurableState> = string & {
  readonly [cellStateBrand]: (state: State) => State;
};

type StubDisk = Map<string, string>;

type StoredAlarm = Readonly<{
  atMs: number;
  payload: DurableValue;
}>;

type StoredCellV1 = Readonly<{
  v: 1;
  state: DurableState;
  alarm: StoredAlarm | null;
}>;

type Runtime = {
  createCell<State extends DurableState>(
    id: string,
    initialState: State,
  ): Cell<State>;
  getSetState<State extends DurableState>(
    cell: Cell<State>,
    patch: Patch<State>,
  ): State;
  scheduleAlarm(
    cell: Cell<DurableState>,
    atMs: number,
    payload: DurableValue,
  ): void;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertDurable(value: unknown): void {
  const seen = new WeakSet<object>();

  const walk = (node: unknown): void => {
    if (node === null) {
      return;
    }
    switch (typeof node) {
      case "string":
      case "boolean":
        return;
      case "number":
        if (!Number.isFinite(node)) {
          throw new Error("unserializable value");
        }
        return;
      case "object": {
        if (seen.has(node)) {
          throw new Error("unserializable value");
        }
        seen.add(node);
        if (Array.isArray(node)) {
          for (const item of node) {
            if (item === undefined) {
              throw new Error("unserializable value");
            }
            walk(item);
          }
          return;
        }
        if (!isPlainObject(node)) {
          throw new Error("unserializable value");
        }
        for (const key of Object.keys(node)) {
          const child = node[key];
          if (child === undefined) {
            throw new Error("unserializable value");
          }
          walk(child);
        }
        return;
      }
      case "undefined":
      case "function":
      case "symbol":
      case "bigint":
        throw new Error("unserializable value");
      default: {
        const _exhausted: never = node;
        throw new Error(`unserializable value: ${String(_exhausted)}`);
      }
    }
  };

  walk(value);
}

function encodeJson(value: unknown): string {
  assertDurable(value);
  return JSON.stringify(value);
}

function jsonClone<Value>(value: Value): Value {
  return JSON.parse(encodeJson(value)) as Value;
}

function encodeStoredCell(record: StoredCellV1): string {
  return encodeJson(record);
}

function decodeStoredCell(raw: string): StoredCellV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("corrupt cell record");
  }
  if (!isPlainObject(parsed) || parsed.v !== 1 || !isPlainObject(parsed.state)) {
    throw new Error("corrupt cell record");
  }
  const alarm = parsed.alarm;
  if (alarm === null) {
    return {
      v: 1,
      state: parsed.state as DurableState,
      alarm: null,
    };
  }
  if (
    !isPlainObject(alarm) ||
    typeof alarm.atMs !== "number" ||
    !Number.isFinite(alarm.atMs) ||
    !("payload" in alarm)
  ) {
    throw new Error("corrupt cell record");
  }
  return {
    v: 1,
    state: parsed.state as DurableState,
    alarm: {
      atMs: alarm.atMs,
      payload: alarm.payload as DurableValue,
    },
  };
}

function parseId(id: string): string {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("id must be a non-empty string");
  }
  return id;
}

function asCell<State extends DurableState>(id: string): Cell<State> {
  return id as Cell<State>;
}

function applyStatePatch<State extends DurableState>(
  state: State,
  patch: Patch<State>,
): State {
  const next: Record<string, DurableValue> = { ...state };
  for (const key of Object.keys(patch)) {
    const value = (patch as Record<string, DurableValue | undefined>)[key];
    if (value === undefined) {
      continue;
    }
    next[key] = value;
  }
  return next as State;
}

function loadCell(disk: StubDisk, id: string): {
  raw: string;
  record: StoredCellV1;
} {
  const raw = disk.get(id);
  if (raw === undefined) {
    throw new Error(`cell not found: ${id}`);
  }
  return { raw, record: decodeStoredCell(raw) };
}

function readAlarm(disk: StubDisk, id: string): StoredAlarm {
  const { record } = loadCell(disk, id);
  if (record.alarm === null) {
    throw new Error("expected a persisted alarm");
  }
  return record.alarm;
}

function poisonInitial<State extends DurableState>(initialState: State): State {
  return { ...initialState, __poison: true } as State;
}

function openRuntime(disk: StubDisk): Runtime {
  return {
    createCell<State extends DurableState>(
      id: string,
      initialState: State,
    ): Cell<State> {
      const cellId = parseId(id);
      if (disk.has(cellId)) {
        return asCell(cellId);
      }
      if (!isPlainObject(initialState)) {
        throw new Error("initialState must be a JSON object");
      }
      const record: StoredCellV1 = {
        v: 1,
        state: jsonClone(initialState),
        alarm: null,
      };
      disk.set(cellId, encodeStoredCell(record));
      return asCell(cellId);
    },

    getSetState<State extends DurableState>(
      cell: Cell<State>,
      patch: Patch<State>,
    ): State {
      const { raw, record } = loadCell(disk, cell);
      const state = applyStatePatch(record.state as State, patch);
      const encoded = encodeStoredCell({
        v: 1,
        state,
        alarm: record.alarm,
      });
      if (encoded !== raw) {
        disk.set(cell, encoded);
      }
      return jsonClone(state);
    },

    scheduleAlarm(
      cell: Cell<DurableState>,
      atMs: number,
      payload: DurableValue,
    ): void {
      if (typeof atMs !== "number" || !Number.isFinite(atMs)) {
        throw new Error("atMs must be a finite number");
      }
      const { record } = loadCell(disk, cell);
      disk.set(
        cell,
        encodeStoredCell({
          v: 1,
          state: record.state,
          alarm: { atMs, payload: jsonClone(payload) },
        }),
      );
    },
  };
}

const defaultDisk: StubDisk = new Map();
const defaultRuntime = openRuntime(defaultDisk);

export const createCell: Runtime["createCell"] = defaultRuntime.createCell;
export const getSetState: Runtime["getSetState"] = defaultRuntime.getSetState;
export const scheduleAlarm: Runtime["scheduleAlarm"] =
  defaultRuntime.scheduleAlarm;

export function assertPersist<State extends DurableState>(spec: {
  id: string;
  initialState: State;
  patch: Patch<State>;
  atMs: number;
  payload: DurableValue;
}): { state: State; alarm: { atMs: number; payload: DurableValue } } {
  const disk: StubDisk = new Map();
  const live = openRuntime(disk);
  const cell = live.createCell(spec.id, spec.initialState);
  const mutated = live.getSetState(cell, spec.patch);
  Object.assign(mutated, { tampered: true });
  live.scheduleAlarm(cell, 0, "decoy");
  live.scheduleAlarm(cell, spec.atMs, spec.payload);

  const restartDisk: StubDisk = new Map(disk);
  const beforeAdopt = restartDisk.get(spec.id);
  const revived = openRuntime(restartDisk);
  const adopted = revived.createCell(spec.id, poisonInitial(spec.initialState));
  assert.equal(restartDisk.get(spec.id), beforeAdopt);

  const state = revived.getSetState(adopted, {});
  const alarm = readAlarm(restartDisk, spec.id);
  const expectedState = applyStatePatch(spec.initialState, spec.patch);
  assert.deepEqual(state, expectedState);
  assert.deepEqual(alarm, { atMs: spec.atMs, payload: spec.payload });
  return { state, alarm };
}
