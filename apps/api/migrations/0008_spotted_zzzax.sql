-- Every workspace that already existed gets the rest of its own theme, instead
-- of the default 0007 handed it ("Choose a workspace's colors from a palette",
-- issue 79).
--
-- A workspace has always had a tint, and the palette's themes are built around
-- exactly those tints - so the tint is the key, and this is the whole mapping,
-- written out. The seeded Work, Atlas Copco and Personal keep the identity the
-- prototype gave them: its three tints, and the two page grounds it hard-codes
-- in `poc/prototype/styles.css` beside the default one on `:root`.
--
-- **A workspace whose tint is in no theme keeps the default, and that is the
-- decision rather than an oversight.** It is not matched by any statement
-- below, so it keeps what 0007 gave it: the first theme's ground and header,
-- beside whatever tint it has. That leaves one workspace looking slightly
-- wrong - a dot in one hue on a page in another - and the alternatives are
-- worse. Failing the deploy over a color is the wrong loudness for something
-- nobody can be harmed by, and overwriting the tint would change the one thing
-- about that workspace a person already recognises in the tabs. Contrast the
-- name index in 0005, which *does* refuse: two workspaces sharing a name is two
-- things a person cannot tell apart, which is a different order of wrong.
--
-- Staging is the only place this path will actually be taken. Preview is
-- re-seeded from seed.sql on every deploy and production is seeded by hand, so
-- both hold only the three seeded tints; staging is deliberately never seeded
-- and has whatever has accumulated.
--
-- **Re-runnable, every statement.** They are assignments keyed on the tint, so
-- running them again writes the same values over the same rows - which matters
-- because 0007 is not re-runnable, and a deploy that fails there and is retried
-- runs this file again from the top afterwards. Nothing here can fail on the
-- data it finds either: no constraint, no uniqueness, no shape to violate.
--
-- **The window it can be interrupted in.** Between any two statements, some
-- workspaces have their theme and the rest still have the default. Both are
-- workspaces that render, and the retry finishes the job. There is no state
-- here in which anything is unreadable.
UPDATE `workspaces` SET `ground` = '#e3e1f2', `header` = '#d2cdea' WHERE `color` = '#6f62b5';--> statement-breakpoint
UPDATE `workspaces` SET `ground` = '#d8e5f7', `header` = '#bed6f2' WHERE `color` = '#3a72c8';--> statement-breakpoint
UPDATE `workspaces` SET `ground` = '#f2e5d4', `header` = '#ead2b3' WHERE `color` = '#c06a45';--> statement-breakpoint
UPDATE `workspaces` SET `ground` = '#d9ece6', `header` = '#bcdcd2' WHERE `color` = '#3f8f78';--> statement-breakpoint
UPDATE `workspaces` SET `ground` = '#f2dfec', `header` = '#e8c6dc' WHERE `color` = '#a8548c';--> statement-breakpoint
UPDATE `workspaces` SET `ground` = '#f2e9d3', `header` = '#e9dab0' WHERE `color` = '#b58a2f';--> statement-breakpoint
UPDATE `workspaces` SET `ground` = '#dbeaf0', `header` = '#bfdae5' WHERE `color` = '#4f8fa8';--> statement-breakpoint
UPDATE `workspaces` SET `ground` = '#e6ebd6', `header` = '#d3dcb6' WHERE `color` = '#7d8f3f';
