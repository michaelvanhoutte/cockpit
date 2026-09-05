# raw html and link schemes


## Milkdown (commonmark + gfm, html node left in)

- **a script tag** — markdown: "<script>alert(1)</script>\n"; dom: "<p><span data-value=\"<script>alert(1)</script>\" data-type=\"html\">&lt;script&gt;alert(1)&lt;/script&gt;</span><img class=\"ProseMirror-separator\" alt=\"\"><br class=\"ProseMirror-trailingBreak\"></p>"
- **an image with a handler** — markdown: "<img src=x onerror=alert(1)>\n"; dom: "<p><span data-value=\"<img src=x onerror=alert(1)>\" data-type=\"html\">&lt;img src=x onerror=alert(1)&gt;</span><img class=\"ProseMirror-separator\" alt=\"\"><br class=\"ProseMirror-trailingBreak\"></p>"
- **a bare bold tag** — markdown: "a <b>bold</b> word\n"; dom: "<p>a <span data-value=\"<b>\" data-type=\"html\">&lt;b&gt;</span>bold<span data-value=\"</b>\" data-type=\"html\">&lt;/b&gt;</span> word</p>"
- **a javascript link** — markdown: "[click](javascript:alert\\(1\\))\n"; dom: "<p><a href=\"\">click</a></p>"
- **a data link** — markdown: "[click](data:text/html,<script>alert\\(1\\)</script>)\n"; dom: "<p><a href=\"\">click</a></p>"
- **a vbscript link** — markdown: "[click](vbscript:msgbox\\(1\\))\n"; dom: "<p><a href=\"\">click</a></p>"
- **a mailto link** — markdown: "[mail](mailto:a@example.com)\n"; dom: "<p><a href=\"mailto:a@example.com\">mail</a></p>"
- **an http link** — markdown: "[plain](http://example.com)\n"; dom: "<p><a href=\"http://example.com\">plain</a></p>"