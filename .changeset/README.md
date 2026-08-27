# Changesets

Add a changeset for user-visible changes that should be included in a release:

```sh
bun run changeset
```

Choose `expensifier`, select the SemVer impact, and describe the change for the changelog. The release workflow collects committed changesets into a version pull request. Merging that pull request creates the package tag, GitHub release, and GHCR image without publishing to npm.
