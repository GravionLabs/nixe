# Bases

A `.base` file shows the notes of the vault as a table or as [cards](#cards). The format is the one of
[Obsidian Bases](https://obsidian.md/help/bases/syntax); Nixe supports a first part of it and never
writes a `.base` file. The table [edits](#editing-cells) the properties of the notes. A note can
[show a base](#bases-in-notes) of its own or [embed](#embedding-a-base-file) a `.base` file.

## Opening a base

The file tree lists `.base` files, also in folders that contain nothing else that is listed. A click
(in the tree or on a bookmark) opens the base in a tab of its own; a second click focuses that tab. The tab is not restored with the
layout. [Vault health](cli.md) does not count a base as an unused attachment.

## Bases in notes

A fenced `base` block holds the text of a `.base` file; the reading view shows the base in its place:

````markdown
```base
filters: file.hasLink(this.file)
views:
  - type: table
    name: Mentions
    order: [file.name, file.mtime]
  - type: cards
    name: Cards
```
````

- Views, filters, formulas, sorting, grouping and the [view switcher](#views) work as in the tab of a
  base file. The chosen view and a clicked sort stay while the note is shown; editing the block or
  opening another note drops them.
- [`this`](#this) is the note that holds the block. A block in an embedded note (`![[Note]]`)
  belongs to that note.
- The block follows changes in the vault. `this` reads the saved note from the index, so unsaved
  changes of its properties and links count after a save.
- The values are read-only: [cells are edited](#editing-cells) in the tab of a `.base` file.
- Invalid content shows its [error](#errors) in place of the block; the rest of the note is shown.
- A block of a note outside the open vault, or of an unsaved new note, says that it is not supported.
- [Export, print](export.md), the published [site](export.md) and the link preview show a note that
  the base is shown in the reading view. The editor with live preview and the rich diff show the
  block as code.

### Embedding a base file

`![[Books.base]]` shows the base of a `.base` file in the reading view, `![[Books.base#Cards]]`
starts with the view of that name:

```markdown
![[Books.base]]
![[library/Books.base#Reading list]]
```

- The file is resolved like a wikilink: a path from the vault root, else a name that is
  unique in the vault, without regard to case. The extension `.base` is needed.
- Without a view name the base starts like in its tab. The name is that of the view in the file; case
  does not matter when no view has it exactly. The switcher shows the other views.
- A file that is not found (also a name that two files have) shows `Base not found: …`, a view name
  that the file does not have `View not found: …`, both in place of the base.
- The embed follows changes of the `.base` file, also when it is created, renamed or deleted.
- Everything else is as for a `base` block: [`this`](#this) is the note that holds the embed, the
  values are read-only, and [export, print](export.md) and the link preview show a note that the base
  is shown in the reading view. The editor with live preview, the rich diff and the published
  [site](export.md) show the embed as a link to the file.

## What is shown

The tab shows one view at a time, at first the first view of type `table`, without one the first
view. A view has one row (or [card](#cards)) per
indexed note that matches the [filters](#filters), sorted by path unless the view
[sorts](#sorting) them. The columns are the entries of the view's `order`:

| Entry | Column |
| --- | --- |
| `file.name` | The name of the note without its extension; a click opens the note |
| every other [`file.` field](#file-fields) | The value of the field; dates in local time as `YYYY-MM-DD hh:mm:ss`, lists separated by commas, `file.properties` as `key: value` items |
| `status`, `note.status`, `note["status"]` | The note property `status` (the name ignores case) |
| `formula.total`, `formula["total"]` | The value of the [formula](#formulas) `total`. A `true` or `false` shows as a checkbox, a [date](#dates-and-durations) as `YYYY-MM-DD`, with ` hh:mm:ss` when it has a time, a duration in words (`1 day 2 hours`), a [link](#links) can be clicked, an error shows in the cell |

Without `order` the only column is `file.name`; the same column is shown when no entry of `order` is
supported. `properties.<id>.displayName` sets the header of a column. A checkbox property shows as a
checkbox, a list as its items separated by commas, a missing property as an empty cell.

```yaml
properties:
  status:
    displayName: State
views:
  - type: table
    order:
      - file.name
      - status
```

The table follows changes in the vault, those of the `.base` file included.

## Views

The switcher in the header lists all views of the base by `name`, in the order of the file (a view
without a name as `View 2`, by its place). `table` and [`cards`](#cards) views can be shown; another
type shows a message and the switcher stays. The chosen view belongs to the tab and follows the view by its name
when the file changes; when it is gone, the first table view shows again, without the sort of a
clicked header.

```yaml
properties:
  status:
    displayName: State
views:
  - type: table
    name: Reading list
    groupBy:
      property: status
      direction: ASC
    groupOrder:
      - reading
      - wish
      - null
    sort:
      - property: rating
        direction: DESC
      - property: file.name
        direction: ASC
    limit: 20
    order: [file.name, rating]
```

| Key of the view | Meaning |
| --- | --- |
| `sort` | The saved sort: a list of `property` and `direction`; the first entry counts most |
| `groupBy` | `property` and `direction`: the rows are put into groups by the value of the property |
| `groupOrder` | The values of the groups that show, in this order. Rows of other groups are hidden; an empty list hides all. `null` stands for the rows without a value. A listed group without rows shows with `0`. Without `groupBy` it has no effect |
| `limit` | At most this many rows; a whole number of 1 or more |

A `property` is written like an entry of `order` and needs no column. `direction` is `ASC` (also
when left out) or `DESC`.

The keys `sort`, `groupBy`, `groupOrder` and `limit` are those Obsidian writes into a `.base` file.
The [syntax page](https://obsidian.md/help/bases/syntax) describes `groupBy`, `groupOrder` and
`limit` but does not name the key of the saved sort; `sort` with `property` and `direction` was
checked against bases saved by Obsidian, for example
[this one](https://github.com/BipinJungRai/NOAT/blob/26d835804df64d47fdbd0b024946c59980d1ffce/00%20Meta/Bases/Literature.base).
Earlier versions of Obsidian named the property of a `sort` entry `column`
([example](https://github.com/kepano/kepano-obsidian/blob/main/Templates/Bases/Shows.base)); it is
read too. (`order` is not a sort: it lists the columns.)

The rows of hidden groups are dropped first, the others are sorted, `limit` keeps the first of them
and these are put into their groups. The limit therefore counts over all groups; a group of an
automatic order (without `groupOrder`) that gets no row does not show.

### Sorting

- Numbers, dates and durations by their size, `false` before `true`, texts alphabetically without
  regard to case, lists item by item. Values of different types are grouped as by
  [`sort()`](#functions) of a list.
- Rows without a value (also an empty text or list) come last in both directions.
- Rows that are equal stay sorted by path.
- Groups follow the `direction` of `groupBy` in the same order, the group `No value` last. An entry
  of `groupOrder` matches a value that is written the same (`3` and `"3"`); a list value needs a
  list entry.
- A formula that fails for a note in the `sort` or `groupBy` of the view is an [error](#errors).

A click on a column header sorts by that column: ascending, a second click descending, a third one
returns to the sort of the view, which also decides between equal rows meanwhile. `limit` applies
to the rows in this order. A formula that fails sorts like a missing value here. This sort belongs
to the tab: switching the view drops it, and nothing is written to the file.

## Editing cells

In a table, a cell of a note property is edited in place and written into the frontmatter of the
note of its row. `file.` fields and formulas are read-only, and so are [cards](#cards).

A click on a cell shows its input; a checkbox is switched at once. Enter or leaving the cell takes
the value, Escape drops it.

| Value | Input |
| --- | --- |
| Text and links | A text field with the value as written (`[[Note]]`); several lines in a text area |
| Number | A number field; an empty or invalid entry changes nothing |
| Checkbox | A checkbox, undetermined while the property is missing |
| Date | A date picker; a date with a time, and a day that does not exist, is a text field |
| List, `tags`, `aliases` | The items with a button to remove each, and a field that adds one with Enter or `,` |

The type is that of the value; `tags` and `aliases` are always lists. An empty cell takes the type
of the first value in its column, else it is a text. A mapping, and a list that holds one, is
read-only.

Only the lines of the edited property change: comments, the order and the other lines stay as they
are. The key that differs in case only is the one that is changed. A quoted text stays quoted, a
`[a, b]` list stays on one line, and a list of `- item` lines keeps its comment lines. A note
without frontmatter gets one. A change that cannot be written without damaging the frontmatter
(a list item that an alias points to, a `[a, b]` list with comments inside, a comment between a
key and its value) is refused.

- A note that is **open in an editor** takes the change in the editor, together with its unsaved
  changes, and is saved at once. The change is refused while the editor asks what to do with a
  change on disk.
- Any **other note** is read, changed and written atomically, only while the file still holds what
  was read. A change made in between is not overwritten.
- Edits of the same note are applied one after the other.

The cell shows the new value while it is written. When it cannot be written (a change on disk,
invalid frontmatter, a file that is not UTF-8, a failed write), the old value comes back, a message
says why and the log has it. Only when you type in the note while its save fails does the change
stay in the editor; the message says so.

Renaming or deleting properties and creating notes from a base are not supported.

## Cards

A view of `type: cards` shows one card per note: the cover image, the name of the note and below it
every other entry of `order` with its header and value, written as in a [table cell](#what-is-shown).
[Filters](#filters), `sort`, `groupBy`, `groupOrder` and `limit` apply as in a table; a group has its
heading above its cards. Cards have no headers to click, so only the saved sort applies.

A click on a card opens the note, a click on a link in a value opens its target. The cards fill the
width of the tab in columns; in a pane narrower than a card there is one column as wide as the pane.

```yaml
views:
  - type: cards
    name: Library
    image: note.cover
    imageFit: contain
    imageAspectRatio: 1.5
    cardSize: 180
    order: [file.name, author, rating]
```

| Key of the view | Meaning |
| --- | --- |
| `image` | The property the cover comes from (a note property, a formula or a `file.` field), written like an entry of `order`. Without it the cards have no cover |
| `imageFit` | `cover` (also when empty or left out): the image fills the cover and is cut where it does not fit; `contain`: the whole image shows |
| `imageAspectRatio` | The height of the cover as a multiple of its width: `1` (default) is a square, `1.5` is taller, `0.5` flatter. Kept between 0.1 and 10 |
| `cardSize` | The width of a card in pixels, at least; the cards of a row share the space that is left. Default 200, kept between 50 and 800 |

The [cards page](https://obsidian.md/help/bases/views/cards) names the four settings, the kinds of
image values, the two fits and the square default, but not the keys of the file. The keys and the
meaning of the ratio (height by width) were checked against bases saved by Obsidian, for example
[this one](https://github.com/sapegin/dotfiles/blob/08d5eb8f15fd80ffc5a959c392a3175327ee3ea5/obsidian/zz-bases/Recipes.base),
and a [comparison with Obsidian 1.15.0](https://github.com/quartz-community/dev-mode/tree/8c93bd4cb9643a3c61b460f6ab2e45bc76bcb8e8/e2e/repros/bases-cards-obsidian).
The default width and the ranges are Nixe's own.

### Cover images

The value of the `image` property names the cover; it is resolved like an image in the note:

| Value | Cover |
| --- | --- |
| `"[[photo.png]]"`, `"![[photo.png\|300]]"` | The file of the vault the [link](#links) names; the size is ignored |
| `img/photo.png`, `/art/photo.png` | The file at that path, seen from the folder of the note (with a leading `/` from the vault root); else resolved like a link. `%20` and the like are read, a `?…` or `#…` at the end is ignored |
| `https://…`, `http://…` | The web image. As in notes, the app's content policy loads `https:` only |
| `"#ff8800"` | The color |
| a [link](#links) from a formula | Its file or web address |

Images are the files notes embed as images (`png`, `jpg`, `jpeg`, `gif`, `svg`, `webp`, `bmp`,
`avif`). A card with no value, a list, another kind of value or file, a file that is not in the
vault, a failing formula or an image that cannot be loaded shows a placeholder. Files outside the
vault and `data:` addresses are not loaded.

## Formulas

`formulas` of the base maps names to [expressions](#expressions). Each is evaluated per note and used
as `formula.<name>` (or `formula["my name"]`) in `order`, in filters and in other formulas. The order
of the definitions does not matter; the name is matched exactly. `properties.formula.<name>.displayName`
sets the header of its column.

```yaml
formulas:
  price_text: if(price, price.toFixed(2) + " €")
  per_page: if(pages, (price / pages).toFixed(3))
  cheap: price.isTruthy() && price < 10
views:
  - type: table
    filters: formula.cheap
    order: [file.name, formula.price_text, formula.per_page]
```

A formula cannot be evaluated when it has a syntax error or an unknown function, refers to an unknown
formula, is part of a cycle (formulas that refer back to each other, also in a branch of `if` that is
never taken) or refers to such a formula. Every cell of its column then shows the message, for example
``the formulas form a cycle: `a` → `b` → `a` ``; a filter that refers to it is an
[error](#errors). A formula that nothing uses does no harm.
Long messages are shortened.

The formula values of one note are limited to 1 000 000 characters and items together, those of all
formula cells of a table to 10 000 000; what goes beyond shows an error.

## Filters

`filters` of the base and `filters` of the shown view both have to match. Each is an expression, or
a mapping with one of these keys over a list of expressions and further such mappings:

| Key | Matches when |
| --- | --- |
| `and` | every entry matches |
| `or` | at least one entry matches |
| `not` | no entry matches |

Empty filters and a group without entries set no condition.

```yaml
filters:
  or:
    - file.hasTag("book")
    - and:
        - file.inFolder("reading")
        - not:
            - status == "done"
views:
  - type: table
    filters: rating >= 4 && !archived
```

An entry is a text. Quote an expression that YAML would read as something else: one that starts with
`!`, `[`, `{` or a quote, contains `: ` or ` #`, or is just `true` or `false` inside a group.

### Expressions

- Literals: text in `"…"` or `'…'` (`\` escapes the next character, `\n` and `\t` are a line break
  and a tab), numbers (`3`, `1.5`), `true`, `false`, lists (`[1, "a"]`).
- Note properties: `status`, `note.status`, `note["my status"]`; the name ignores case. A name with
  spaces or `-` needs the bracket form. A property written as `YYYY-MM-DD`, optionally with a time,
  is a [date](#dates-and-durations).
- [Formulas](#formulas): `formula.total`, `formula["my total"]`.
- [Functions](#functions), global ones (`max(a, b)`) and those of a value (`title.lower()`).
- Operators, tightest first: `!` and unary `-`; `*` `/` `%`; `+` `-`; `<` `<=` `>` `>=`;
  `==` `!=`; `&&`; `||`. Parentheses group.

### This

`this` is the file the base is shown in: the base file in its own tab, the embedding note for a
[block in a note](#bases-in-notes).

| Expression | Value |
| --- | --- |
| `this`, `this.file` | A [link](#links) to the file |
| `this.file.name`, `this.file.folder`, … | A [file field](#file-fields) of it |
| `this.file.hasTag(…)`, `this.file.hasLink(…)`, … | A [file function](#file-functions) of it |
| `this.status`, `this.note.status`, `this["status"]` | Its property `status`; a base file has none |

```yaml
filters:
  or:
    - file.hasLink(this.file)
    - author == this
    - editors.contains(this)
    - file.folder == this.file.folder
```

Compared with `this` (`==`, `!=` and the `contains` functions of a list), a property that is a
wikilink (`"[[Ann]]"`) counts as the file it names; `contains(this)` also takes a property that is a
single text instead of a list. `this` can be used in filters and formulas, not
as an entry of `order`, `sort` or `groupBy`; put it into a [formula](#formulas) for that.

### File fields

| Field | Value |
| --- | --- |
| `file.name` | The file name with its extension (`Dune.md`); the column of the same name leaves it out |
| `file.basename` | The file name without its extension |
| `file.path` | The path from the vault root |
| `file.folder` | The path of the folder; empty for a note in the root |
| `file.ext` | The extension without the dot (`md`) |
| `file.size` | The size in bytes |
| `file.ctime`, `file.mtime` | When the file was created and last changed. Where the file system records no creation time, `ctime` is the change time; a save that replaces the file can renew it |
| `file.tags` | The tags of the text and the frontmatter, without `#` |
| `file.links` | The targets of the wikilinks and Markdown links: the path of the file, else the target as written |
| `file.embeds` | The same for embeds (`![[…]]`) |
| `file.backlinks` | The paths of the other notes that link to or embed this one |
| `file.properties` | The frontmatter properties |

Links inside frontmatter values are not indexed and count in none of these.

### File functions

| Function | True when |
| --- | --- |
| `file.hasTag("a", "b")` | the note has one of the tags or a tag nested below one (`a/x`); case and a leading `#` do not matter |
| `file.inFolder("folder")` | the note is in the folder or below it |
| `file.hasLink("Note")` | the note links to or embeds that file; a name, a path or `[[…]]`, resolved like a link. A target that is no file matches links written the same way |
| `file.hasProperty("name")` | the frontmatter has the property; the name ignores case |

### Functions

They follow [Obsidian](https://obsidian.md/help/bases/functions) and JavaScript. Square brackets mark
an argument that can be left out. A number written before a dot needs no parentheses unless it is
negative (`(-5).abs()`).

| Global | Value |
| --- | --- |
| `if(condition, then, [else])` | `then` when the condition is true, else `else` (no value when left out). Only the chosen one is evaluated |
| `list(x)` | `x` when it is a list, else a list of `x`; empty for no value |
| `number(x)` | `x` as a number: a text is read (an error when it holds no number), `true` is 1, `false` 0, a date its milliseconds since 1970, a duration its length in milliseconds |
| `date(x)` | The [date](#dates-and-durations) a text names (`YYYY-MM-DD`, optionally `hh:mm[:ss]` and a zone); a date stays as it is. Any other text is an error |
| `duration(x)` | The [duration](#dates-and-durations) a text names (`"1 week"`); a duration stays as it is. Any other text is an error |
| `now()`, `today()` | The current date and time; the current day without a time. All rows of a table see the same moment |
| `min(a, b, …)`, `max(a, b, …)` | The smallest or largest of the numbers |
| `link(path, [text])` | A [link](#links) |

| Any value | Value |
| --- | --- |
| `x.isTruthy()` | Whether `x` counts as true ([values](#values)) |
| `x.isType(type)` | Whether `x` has the type `"null"`, `"boolean"`, `"number"`, `"string"`, `"date"`, `"duration"`, `"list"`, `"object"` or `"link"` |
| `x.toString()` | `x` as text: lists joined by commas, dates in local time, durations in words, a link as `[[target]]`, empty for no value |

| Text | Value |
| --- | --- |
| `s.length` | The number of characters |
| `s.contains(a)` | Whether `s` holds the text `a`; case counts, here and below |
| `s.containsAll(a, b, …)`, `s.containsAny(a, b, …)` | Whether it holds all of them, or at least one |
| `s.startsWith(a)`, `s.endsWith(a)` | Whether it starts or ends with `a` |
| `s.isEmpty()` | Whether there is no text: empty or no value |
| `s.lower()`, `s.title()` | In lower case; every word with a capital first letter and the rest lower |
| `s.trim()`, `s.reverse()` | Without white space at both ends; backwards |
| `s.replace(a, b)` | Every `a` replaced by `b` |
| `s.slice(start, [end])` | The characters from `start` (counted from 0) up to before `end`; a negative position counts from the end |
| `s.split(separator, [n])` | The parts between the separator, at most the first `n`; an empty separator splits into characters |
| `s.repeat(n)` | `s`, `n` times |

| Number | Value |
| --- | --- |
| `n.abs()`, `n.ceil()`, `n.floor()` | Without sign; rounded up; rounded down |
| `n.round([digits])` | Rounded to a whole number or to `digits` decimal places; a half goes up |
| `n.toFixed(digits)` | A text with exactly `digits` decimal places |
| `n.isEmpty()` | Whether there is no number |

| Date | Value |
| --- | --- |
| `d.year`, `d.month`, `d.day` | The year, the month (1–12) and the day of the month, in local time |
| `d.hour`, `d.minute`, `d.second`, `d.millisecond` | The parts of the time (0–23, 0–59, 0–59, 0–999) |
| `d.date()` | The day without the time |
| `d.time()` | The time as `hh:mm:ss` |
| `d.format(format)` | The date written with [Moment.js tokens](https://momentjs.com/docs/#/displaying/format/) in English (`"DD.MM.YYYY"`); text in `[brackets]` stays; a format has at most 1000 bytes |
| `d.relative()` | The distance from now in words (`3 days ago`, `in a month`) |
| `d.isEmpty()` | `false` |

| List | Value |
| --- | --- |
| `l.length` | The number of items |
| `l.contains(a)` | Whether an item equals `a` (as `==` does) |
| `l.containsAll(a, b, …)`, `l.containsAny(a, b, …)` | Whether it contains all of them, or at least one |
| `l.join(separator)` | The items as one text with the separator between them |
| `l.flat()` | The items of lists inside the list in their place, one level deep |
| `l.unique()` | Without repeated items; the first one stays |
| `l.sort()` | Smallest first. Items of different types are grouped: booleans, numbers, dates, durations, texts, links, lists and mappings, missing values |
| `l.reverse()` | Backwards |
| `l.slice(start, [end])` | The items from `start` (counted from 0) up to before `end`; a negative position counts from the end |
| `l.isEmpty()` | Whether it has no item |

The functions of a list give a new list; the property or formula keeps its items.

- On a missing value, or with a missing argument, a function has no value. Exceptions: `isTruthy` is
  false, `isEmpty` true, `isType("null")` true, `toString` empty, `list` empty, and `if` takes a
  missing condition as false. `now()` and `today()` take no argument and always have a value.
- A function on a value of a type it does not take (`rating.lower()` on a number, `lower` on a list,
  `contains` on a date) is an error, as is an argument of the wrong type and a result of more than 100 000
  characters and items together. Guard a property of mixed types with `isType`:
  `if(rating.isType("number"), rating.round())`.

#### Dates and durations

A date is a day (`2026-06-10`) or a point in time of the years 0 to 9999; a zone is written `Z`,
`+01:00` or `+0100`, and without one the time is local. A text of more than 100 bytes names no date
and no duration. `link` and `file.hasLink` take a date as the name of a note (a daily note). Dates are the date
properties of the notes, `file.ctime`, `file.mtime` and what `date`, `now` and `today` give. A text
property that only looks like a date (`2026-02-30`) and the items of a list property stay texts.

A duration is a number and a unit, with or without a space:

| Unit | Written |
| --- | --- |
| Year, month | `y`, `year`, `years`; `M`, `month`, `months`; whole numbers only |
| Week, day | `w`, `week`, `weeks`; `d`, `day`, `days` |
| Hour, minute, second | `h`, `hour`, `hours`; `m`, `minute`, `minutes`; `s`, `second`, `seconds` |

| Expression | Value |
| --- | --- |
| `date + "1M"`, `date - "2h"` | The date moved by the duration, a text or `duration(…)`. Chains add one after the other: `date("2024-12-01") + "1M" + "4h"` |
| `date - date` | The duration between them; between two days without a time, whole days |
| `duration + duration`, `duration - duration` | Their sum or difference; the right side can be a text |
| `duration * n`, `duration / n` | `n` times as long, or a part of it; the duration stands on the left |
| `<` `<=` `>` `>=` `==` `!=` | Dates compare by their moment, also with a text that names a date; durations by their length, also with a text |

- Years and months follow the calendar: one month after January 31 is the last day of February. A
  day is 24 hours; added to a date without a time, whole days and weeks give a date without a time,
  also across a change of the clock. Hours, minutes and seconds give the date a time.
- Where durations are compared or turned into a number, a month counts 30 days and a year 365. The
  days between two dates as a number: `number(today() - due) / 86400000`.
- Anything else (`date + 1`, a text that is no duration, a result out of range) has no value.

```yaml
formulas:
  overdue: if(due < today(), today() - due)
  recent: file.mtime > now() - "1 week"
  next: (date(last) + "2w").format("DD.MM.YYYY")
```

#### Links

`link("Note")` takes a path, a name or `[[…]]`, resolved like a link in a note; `link("https://…")`
(also `http`, `mailto`, `tel`) is a web address. The second argument is the text shown. A click on the
cell opens the note in a tab or the address outside the app; a link to another kind of file or to no
file is plain text, as is a link inside a list. Two links are equal when they name the same file, or,
where there is no file, the same text ignoring case. `file.hasLink` takes a link too.

### Values

- A missing property has no value. It equals only another missing one, is in no order (`<`, `>`, …
  are false) and counts as false.
- False are: no value, `false`, `0`, an empty text, list or mapping. Everything else is true.
- `==` needs the same type: `"5"` is not `5`, texts compare with case, lists item by item. A date
  or a duration also equals a text that names it.
- Order exists between numbers, between texts, between [dates and durations](#dates-and-durations)
  and between one of those and a text that names one (`file.mtime > "2026-01-01"`).
- `+` adds numbers and joins texts (also a text and a number, and a date or duration after a text);
  `-` `*` `/` `%` take numbers; dates and durations have the
  [operations above](#dates-and-durations). Anything else, a division by zero included, has no value.
  Joined texts have the size limit of the [functions](#functions).

## Not supported yet

These parts are read but not applied; the tab names the ones the file uses, so the table is never
silently sorted or cut wrongly:

- `summaries` of the base and of the view
- columns of unknown `file.` fields, and a `sort`, `groupBy` or `image` by one

In filters and formulas, other functions (the list functions `filter`, `map` and `reduce`,
`html`, `image`, `icon`, `random`, object functions), regular expressions and other fields of values
are not supported: they are [errors](#errors).

Other keys are ignored. Other view types, changing the definition in the tab and the CLI and MCP
are not supported. [Editing](#editing-cells) is limited to the cells of a table.

## Errors

The tab shows a message instead of the table for invalid YAML, a file whose keys have the wrong
shape (also a wrong `sort`, `groupBy`, `groupOrder` or `limit` of the shown view, and a wrong
`image`, `imageFit`, `imageAspectRatio` or `cardSize` of a cards view), a file without a view, a view
that is no `table` or `cards`, a base outside the open vault (in a
further folder of the workspace) and when the vault index is not available. A failed read or query is
written to the log.

A syntax error, an unknown function or field, a formula that cannot be evaluated and a wrong group in
the filters of the base or of the shown view are errors too: the message names the expression, for
example ``Invalid filters: unknown function `file.hasTags` in `file.hasTags("book")`.`` The same holds
for an error that a note causes in a filter (`rating.abs()` on a text); the message names the note as
well. No row is ever hidden by a filter that could not be applied.

An error in the formula of a column stays in its cell; the other cells and rows are shown.

## How it works

The frontend reads the file (also that of an embed), or takes the text of the block, and passes it to the commands
`base_views` and `base_query` ([Tauri commands](backend/tauri-commands.md)), with the path of the
file `this` stands for. The Markdown renderer turns a `base` fence into a placeholder
(`core/markdown/plugins/base-fence.plugin.ts`, for an embed `embed.plugin.ts`); the reading view puts a base component in its place
(`features/bases/base-blocks.ts`) and destroys it before the note is rendered again. The Rust core (`src-tauri/src/bases/`) parses the YAML
and answers the view from the [vault index](architecture.md), sorted, grouped and limited, with the
cover of each card resolved; the frontend only renders the result. Only the answer of the newest query is shown.

An edited cell goes to `NoteEditService` (`core/file/note-edit.service.ts`), which changes the
frontmatter with `editFrontmatter` in the open editor, or writes the file with
`replace_text_file`.
