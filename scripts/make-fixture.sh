#!/usr/bin/env bash
# Build a throwaway git repo with a vitest project (web/) and a dotnet solution (svc/).
# HEAD~1 is the base commit; HEAD changes web/src/a.ts and svc/Lib/Foo.cs.
set -euo pipefail
dir="${1:?usage: make-fixture.sh <dir>}"
mkdir -p "$dir"
cd "$dir"
git init -q -b main
git config user.email fixture@example.test
git config user.name fixture

mkdir -p web/src svc/Lib svc/Lib.Tests web/e2e/app
cat > .gitignore <<'IGN'
node_modules
bin
obj
testscope
IGN
cat > web/package.json <<'JSON'
{ "name": "fixture-web", "private": true, "type": "module" }
JSON
cat > web/vitest.config.ts <<'TS'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.test.ts'] } });
TS
cat > web/src/a.ts <<'TS'
export const a = (): number => 1;
TS
cat > web/src/b.ts <<'TS'
export const b = (): number => 2;
TS
cat > web/src/a.test.ts <<'TS'
import { expect, it } from 'vitest';
import { a } from './a';
it('a', () => expect(a()).toBeGreaterThan(0));
TS
cat > web/src/b.test.ts <<'TS'
import { expect, it } from 'vitest';
import { b } from './b';
it('b', () => expect(b()).toBeGreaterThan(0));
TS
cat > web/e2e/app/x.spec.ts <<'TS'
export {};
TS

cat > svc/Lib/Lib.csproj <<'XML'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><RootNamespace>Fixture.Lib</RootNamespace></PropertyGroup>
</Project>
XML
cat > svc/Lib/Foo.cs <<'CS'
namespace Fixture.Lib;
public class Foo { public int Value() => 1; }
CS
cat > svc/Lib/Bar.cs <<'CS'
namespace Fixture.Lib.Other;
public class Bar { public int Value() => 2; }
CS
cat > svc/Lib.Tests/Lib.Tests.csproj <<'XML'
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net10.0</TargetFramework><RootNamespace>Fixture.Lib.Tests</RootNamespace></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <ProjectReference Include="..\Lib\Lib.csproj" />
  </ItemGroup>
</Project>
XML
cat > svc/Lib.Tests/FooTests.cs <<'CS'
using Xunit;
namespace Fixture.Lib.Tests;
public class FooTests { [Fact] public void Works() => Assert.Equal(1, new Foo().Value()); }
CS
cat > svc/Lib.Tests/BarTests.cs <<'CS'
using Xunit;
namespace Fixture.Lib.Tests.Other;
public class BarTests { [Fact] public void Works() => Assert.Equal(2, new Other.Bar().Value()); }
CS

git add -A
git commit -q -m base

cat > web/src/a.ts <<'TS'
export const a = (): number => 10;
TS
cat > svc/Lib/Foo.cs <<'CS'
namespace Fixture.Lib;
public class Foo { public int Value() => 10; }
CS
git add -A
git commit -q -m head
echo "fixture ready at $dir"
