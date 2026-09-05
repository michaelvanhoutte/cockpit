# tiptap

- **a script tag** — markdown: ""; dom: "<p><br class=\"ProseMirror-trailingBreak\"></p>"
- **an image with a handler** — markdown: ""; dom: "<p><br class=\"ProseMirror-trailingBreak\"></p>"
- **a bare bold tag** — markdown: "a **bold** word"; dom: "<p>a <strong>bold</strong> word</p>"
- **a javascript link** — markdown: "[click](javascript:alert(1))"; dom: "<p><a target=\"_blank\" rel=\"noopener noreferrer nofollow\" href=\"\">click</a></p>"
- **a data link** — markdown: "[click](data:text/html,hi)"; dom: "<p><a target=\"_blank\" rel=\"noopener noreferrer nofollow\" href=\"\">click</a></p>"
- **a vbscript link** — markdown: "[click](vbscript:msgbox(1))"; dom: "<p><a target=\"_blank\" rel=\"noopener noreferrer nofollow\" href=\"\">click</a></p>"
- **a mailto link** — markdown: "[mail](mailto:a@example.com)"; dom: "<p><a target=\"_blank\" rel=\"noopener noreferrer nofollow\" href=\"mailto:a@example.com\">mail</a></p>"
- **an http link** — markdown: "[plain](http://example.com)"; dom: "<p><a target=\"_blank\" rel=\"noopener noreferrer nofollow\" href=\"http://example.com\">plain</a></p>"