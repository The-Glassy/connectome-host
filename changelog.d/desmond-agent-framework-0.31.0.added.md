- **Recipe authors:** `inferenceBounds`, at the recipe's top level, passed to
  agent-framework as written: how long a model call may go without progress
  before it's cut. `{"progressBounds": {"beforeContentMs": 90000}}` gives a
  call 90 seconds to its first content; `progressBounds` also takes
  `betweenEventsMs` and `thinkTokensPerSecond`, the object takes
  `flatMinimumMs`, and `false` sets none of these bounds. A key it doesn't
  know, or a value that isn't a number above 0, stops the load, naming it. A
  host before this release warns that it doesn't read the key, and ignores it.
