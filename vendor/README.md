# Vendored test build (branch up23-361 only)

connectome-host v0.23.0 with one change: `@animalabs/agent-framework` comes from
`animalabs-agent-framework-0.33.0-361-0d852657.tgz` instead of npm. That tarball is
`npm pack` (after `npm run build`, postbuild included) of anima-research/agent-framework
PR #361 head 0d852657 merged with tag v0.33.0 (no conflicts): agent-framework 0.33.0 plus
"a turn refused for budget waits idle until compression makes room".

Not a release. Drop this branch once #361 is in an agent-framework release that a
connectome-host release takes.
