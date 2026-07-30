# slugify

`slugify(s)` turns an arbitrary string into a URL-safe slug:

1. lowercase the whole string;
2. replace every run of one-or-more non-alphanumeric characters with a single hyphen `-`;
3. strip any leading or trailing hyphens.

Examples:
- `slugify("Hello, World!")` → `"hello-world"`
- `slugify("  Leading and trailing  ")` → `"leading-and-trailing"`
- `slugify("a__b--c")` → `"a-b-c"`
- `slugify("Café & Crème")` → `"caf-cr-me"` (only `a–z`/`0–9` survive)
- `slugify("!!!")` → `""`
