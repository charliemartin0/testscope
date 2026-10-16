# CI workflows

`ci.yml` and `self-test.yml` live here because the account that pushed this repo had no `workflow` scope.
Copy them to `.github/workflows/` (`git mv docs/ci-workflows/*.yml .github/workflows/`) from an account that can push workflow files.
`self-test.yml` needs the `TYPESAFE_API_KEY` repository secret for its last (optional) step.
