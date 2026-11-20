// Client-side search over `search-index.js`; works from file:// and from a subpath.
(function () {
  var input = document.getElementById("q");
  var list = document.getElementById("results");
  var root = document.body.getAttribute("data-root") || "";
  var index = window.NIXE_SEARCH || [];
  if (!input || !list) return;

  function snippet(text, word) {
    var at = text.toLowerCase().indexOf(word);
    if (at < 0) return text.slice(0, 120);
    var from = Math.max(0, at - 40);
    return (from > 0 ? "…" : "") + text.slice(from, from + 120);
  }

  function run() {
    var words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    list.textContent = "";
    if (!words.length) {
      list.hidden = true;
      return;
    }
    var hits = [];
    index.forEach(function (n) {
      var title = n.t.toLowerCase();
      var text = n.x.toLowerCase();
      var score = 0;
      for (var i = 0; i < words.length; i++) {
        var inTitle = title.indexOf(words[i]) >= 0;
        if (!inTitle && text.indexOf(words[i]) < 0) return;
        score += inTitle ? 2 : 1;
      }
      hits.push({ n: n, score: score });
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    hits.slice(0, 20).forEach(function (h) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = root + h.n.p;
      a.textContent = h.n.t;
      var small = document.createElement("small");
      small.textContent = snippet(h.n.x, words[0]);
      li.append(a, small);
      list.append(li);
    });
    if (!hits.length) {
      var none = document.createElement("li");
      none.textContent = "No result";
      list.append(none);
    }
    list.hidden = false;
  }

  input.addEventListener("input", run);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      input.value = "";
      run();
    }
  });
})();
