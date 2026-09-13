# celld-do-alarm

The four primitives are `createCell`, `getSetState`, `scheduleAlarm`, and `assertPersist`.

The itch is Academind's [Self-hosted durable objects are pretty interesting!](https://www.youtube.com/watch?v=G-v1hkQ8Sf8). This package keeps state and one alarm in an in-memory `Map<string, string>`. It is not Deno Celld and it is not Cloudflare.

`createCell` is idempotent on `id`. A later call with the same id adopts the stored row and ignores `initialState`. `getSetState` shallow-merges `patch` and returns a fresh JSON clone. An empty patch is a read and does not write. `scheduleAlarm` replaces the single pending alarm. `assertPersist` runs create, patch, and schedule on a private Map. It restarts with `new Map(disk)` and checks that state and alarm survive.

Nothing fires. This is not a product.

```
npm test
```
