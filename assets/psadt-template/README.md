# PSADT company branding template

This folder is the **default company branding overlay** used by `sandbox_psadt_build`. When you build
a PSADT package with `useCompanyTemplate=true` (the default), everything in this folder is copied
**over** the freshly-scaffolded PSADT package — so your logos, banners, config, and strings replace the
toolkit defaults and packages come out on-brand.

## How resolution works

`sandbox_psadt_build` picks the branding template in this order:

1. `templateHostFolder` argument (explicit per-call override), else
2. the `SANDBOX_PSADT_TEMPLATE` environment variable (a host folder path), else
3. **this folder** (the bundled default).

This file (`README.md`) and any `.gitkeep` placeholders are **not** copied into the package.

## What to drop here

Mirror the relative layout of a PSADT v4 package. Common branding paths:

```
Assets/AppIcon.png              # tray / dialog icon
Assets/Banner.Classic.png       # classic UI banner (450 x 100)
Assets/Fluent.Banner.Light.png  # Fluent UI banner (light)
Assets/Fluent.Banner.Dark.png   # Fluent UI banner (dark)
Config/config.psd1              # toolkit config overrides (optional)
Strings/strings.psd1            # UI string overrides (optional)
```

Only include the files you actually want to override — anything you omit keeps the PSADT default.
Filenames must match the toolkit's expected asset names for the PSADT version you target (run
`sandbox_psadt_prereqs` and inspect the cached template's `Assets/` folder to confirm names).

> No real company assets are committed here by default. Replace the placeholder `Assets/` folder with
> your real brand files, or point `SANDBOX_PSADT_TEMPLATE` at a folder that has them.
