

## milkdown-commonmark

### the first formatting set: identical

### a bullet list: normalised
```
IN : "- milk\n- bread\n- eggs"
OUT: "* milk\n* bread\n* eggs\n"
```

### a numbered list: identical

### a nested list: normalised
```
IN : "- release\n  - tag it\n  - write the notes\n- announce"
OUT: "* release\n  * tag it\n  * write the notes\n* announce\n"
```

### a heading: identical

### a table pasted out of Notion: identical

### an image: identical

### a fenced code block: identical

### strikethrough: identical

### a blockquote: identical

### a task list: normalised
```
IN : "- [ ] draft the issue\n- [x] read the options doc"
OUT: "* \\[ ] draft the issue\n* \\[x] read the options doc\n"
```

### inline code: identical

### a mail-client paste, mixed: identical

### a horizontal rule: normalised
```
IN : "Above\n\n---\n\nBelow"
OUT: "Above\n\n***\n\nBelow\n"
```

### a hard line break: normalised
```
IN : "first line  \nsecond line"
OUT: "first line\\\nsecond line\n"
```

### an autolink: identical

### characters Markdown would otherwise eat: normalised
```
IN : "Costs 50% * 2, uses `a_b_c`, and a literal _underscore_."
OUT: "Costs 50% \\* 2, uses `a_b_c`, and a literal _underscore_.\n"
```

### a bare angle bracket: identical

### nothing at all: identical

### sixty thousand characters: identical



## milkdown-gfm

### the first formatting set: identical

### a bullet list: normalised
```
IN : "- milk\n- bread\n- eggs"
OUT: "* milk\n* bread\n* eggs\n"
```

### a numbered list: identical

### a nested list: normalised
```
IN : "- release\n  - tag it\n  - write the notes\n- announce"
OUT: "* release\n  * tag it\n  * write the notes\n* announce\n"
```

### a heading: identical

### a table pasted out of Notion: normalised
```
IN : "| Stage | Owner | Due |\n| --- | --- | --- |\n| Draft | Ana | Fri |\n| Review | Ben | Mon |\n| Ship | Cara | Wed |"
OUT: "| Stage  | Owner | Due |\n| ------ | ----- | --- |\n| Draft  | Ana   | Fri |\n| Review | Ben   | Mon |\n| Ship   | Cara  | Wed |\n"
```

### an image: identical

### a fenced code block: identical

### strikethrough: identical

### a blockquote: identical

### a task list: normalised
```
IN : "- [ ] draft the issue\n- [x] read the options doc"
OUT: "* [ ] draft the issue\n* [x] read the options doc\n"
```

### inline code: identical

### a mail-client paste, mixed: normalised
```
IN : "## Handover\n\nThree things:\n\n1. The **staging** key rotates on Friday — see [the runbook](https://example.com/runbook).\n2. Panels:\n\n| Stage | Owner | Due |\n| --- | --- | --- |\n| Draft | Ana | Fri |\n| Review | Ben | Mon |\n| Ship | Cara | Wed |\n\n3. `pnpm dev` still needs Node 22.\n\n> Ask Ana if any of this is wrong."
OUT: "## Handover\n\nThree things:\n\n1. The **staging** key rotates on Friday — see [the runbook](https://example.com/runbook).\n2. Panels:\n\n| Stage  | Owner | Due |\n| ------ | ----- | --- |\n| Draft  | Ana   | Fri |\n| Review | Ben   | Mon |\n| Ship   | Cara  | Wed |\n\n3. `pnpm dev` still needs Node 22.\n\n> Ask Ana if any of this is wrong.\n"
```

### a horizontal rule: normalised
```
IN : "Above\n\n---\n\nBelow"
OUT: "Above\n\n***\n\nBelow\n"
```

### a hard line break: normalised
```
IN : "first line  \nsecond line"
OUT: "first line\\\nsecond line\n"
```

### an autolink: identical

### characters Markdown would otherwise eat: normalised
```
IN : "Costs 50% * 2, uses `a_b_c`, and a literal _underscore_."
OUT: "Costs 50% \\* 2, uses `a_b_c`, and a literal _underscore_.\n"
```

### a bare angle bracket: identical

### nothing at all: identical

### sixty thousand characters: identical



## tiptap-starter

### the first formatting set: identical

### a bullet list: identical

### a numbered list: identical

### a nested list: identical

### a heading: identical

### a table pasted out of Notion: normalised
```
IN : "| Stage | Owner | Due |\n| --- | --- | --- |\n| Draft | Ana | Fri |\n| Review | Ben | Mon |\n| Ship | Cara | Wed |"
OUT: "| Stage | Owner | Due | | --- | --- | --- | | Draft | Ana | Fri | | Review | Ben | Mon | | Ship | Cara | Wed |"
```

### an image: identical

### a fenced code block: identical

### strikethrough: identical

### a blockquote: identical

### a task list: LOST CONTENT
```
IN : "- [ ] draft the issue\n- [x] read the options doc"
OUT: "- draft the issue\n- read the options doc"
```

### inline code: identical

### a mail-client paste, mixed: LOST CONTENT
```
IN : "## Handover\n\nThree things:\n\n1. The **staging** key rotates on Friday — see [the runbook](https://example.com/runbook).\n2. Panels:\n\n| Stage | Owner | Due |\n| --- | --- | --- |\n| Draft | Ana | Fri |\n| Review | Ben | Mon |\n| Ship | Cara | Wed |\n\n3. `pnpm dev` still needs Node 22.\n\n> Ask Ana if any of this is wrong."
OUT: "## Handover\n\nThree things:\n\n1. The **staging** key rotates on Friday — see [the runbook](https://example.com/runbook).\n2. Panels:\n\n3. `pnpm dev` still needs Node 22.\n\n> Ask Ana if any of this is wrong."
```

### a horizontal rule: identical

### a hard line break: identical

### an autolink: LOST CONTENT
```
IN : "See <https://example.com/deep/link?a=1&b=2>."
OUT: "See [https://example.com/deep/link?a=1&amp;b=2](https://example.com/deep/link?a=1&b=2)."
```

### characters Markdown would otherwise eat: normalised
```
IN : "Costs 50% * 2, uses `a_b_c`, and a literal _underscore_."
OUT: "Costs 50% \\* 2, uses `a_b_c`, and a literal *underscore*."
```

### a bare angle bracket: LOST CONTENT
```
IN : "Compare a < b and b > a."
OUT: "Compare a &lt; b and b &gt; a."
```

### nothing at all: identical

### sixty thousand characters: identical



## tiptap-tables

### the first formatting set: identical

### a bullet list: identical

### a numbered list: identical

### a nested list: identical

### a heading: identical

### a table pasted out of Notion: normalised
```
IN : "| Stage | Owner | Due |\n| --- | --- | --- |\n| Draft | Ana | Fri |\n| Review | Ben | Mon |\n| Ship | Cara | Wed |"
OUT: "\n| Stage  | Owner | Due |\n| ------ | ----- | --- |\n| Draft  | Ana   | Fri |\n| Review | Ben   | Mon |\n| Ship   | Cara  | Wed |\n"
```

### an image: identical

### a fenced code block: identical

### strikethrough: identical

### a blockquote: identical

### a task list: LOST CONTENT
```
IN : "- [ ] draft the issue\n- [x] read the options doc"
OUT: "- draft the issue\n- read the options doc"
```

### inline code: identical

### a mail-client paste, mixed: normalised
```
IN : "## Handover\n\nThree things:\n\n1. The **staging** key rotates on Friday — see [the runbook](https://example.com/runbook).\n2. Panels:\n\n| Stage | Owner | Due |\n| --- | --- | --- |\n| Draft | Ana | Fri |\n| Review | Ben | Mon |\n| Ship | Cara | Wed |\n\n3. `pnpm dev` still needs Node 22.\n\n> Ask Ana if any of this is wrong."
OUT: "## Handover\n\nThree things:\n\n1. The **staging** key rotates on Friday — see [the runbook](https://example.com/runbook).\n2. Panels:\n\n\n| Stage  | Owner | Due |\n| ------ | ----- | --- |\n| Draft  | Ana   | Fri |\n| Review | Ben   | Mon |\n| Ship   | Cara  | Wed |\n\n\n3. `pnpm dev` still needs Node 22.\n\n> Ask Ana if any of this is wrong."
```

### a horizontal rule: identical

### a hard line break: identical

### an autolink: LOST CONTENT
```
IN : "See <https://example.com/deep/link?a=1&b=2>."
OUT: "See [https://example.com/deep/link?a=1&amp;b=2](https://example.com/deep/link?a=1&b=2)."
```

### characters Markdown would otherwise eat: normalised
```
IN : "Costs 50% * 2, uses `a_b_c`, and a literal _underscore_."
OUT: "Costs 50% \\* 2, uses `a_b_c`, and a literal *underscore*."
```

### a bare angle bracket: LOST CONTENT
```
IN : "Compare a < b and b > a."
OUT: "Compare a &lt; b and b &gt; a."
```

### nothing at all: identical

### sixty thousand characters: identical
