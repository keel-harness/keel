# csv

`parseCsvLine(line)` splits one CSV line into an array of field strings.

Rules:
- Fields are separated by commas.
- A field may be wrapped in double quotes. A **quoted** field may contain commas, which are
  part of the value and are NOT separators: `a,"b,c",d` → `["a", "b,c", "d"]`.
- Inside a quoted field, two double quotes (`""`) are an escaped literal quote:
  `"she said ""hi"""` → `she said "hi"`.
- Surrounding quotes are removed from the returned value; unquoted fields are returned as-is.
- An empty line returns `[""]`.
