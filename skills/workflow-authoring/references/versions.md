# Version compatibility

The installed package, capability-contract content, and this skill must describe the same extension version. Read the version line generated at the top of [capabilities](capabilities.md); the skill's frontmatter version and package version must match it.

`present-at` means a capability is confirmed in the recorded version. It is an honest baseline, not a claim about the first historical release that introduced the capability. The contract format has its own version because descriptor shape can evolve separately from extension content.

When copying a workflow between installations:

1. Check the destination's generated version and exact capability facts.
2. Re-check every supported global, option, and constraint used by the script.
3. Treat compatibility entries as preservation aids, not portable recommendations.
4. Re-resolve dynamic model routes and agent types from destination context; static docs intentionally contain no live entries.
5. Prefer runtime behavior when prose and execution disagree, and report the documentation mismatch rather than changing behavior during an authoring fix.
