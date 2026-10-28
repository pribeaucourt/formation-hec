// Décodeur des réponses de ChatGPT et de Gemini copiées depuis les outils de développement de Chrome (F12) :
// fan-out (requêtes lancées par l'IA) et sources (pages consultées, pages citées). Tout se passe dans le navigateur.
// Entrées acceptées : un export HAR de l'onglet Réseau, ou la réponse d'une requête copiée telle quelle.
(function (racine) {
  "use strict";

  function sansSuivi(url) {
    try {
      var u = new URL(url);
      ["utm_source", "utm_medium", "utm_campaign"].forEach(function (p) { u.searchParams.delete(p); });
      u.hash = "";   // ancres de surlignage ajoutées par Gemini (#:~:text=…)
      var s = u.toString();
      return s.replace(/\?$/, "");
    } catch (e) { return url; }
  }
  function domaine(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  }
  var IGNORER = /(^https?:\/\/(www\.)?(google\.com\/s2\/favicons|gstatic\.com|encrypted-tbn|lh\d\.googleusercontent)|\.(png|jpe?g|gif|webp|svg|ico)(\?|$))/i;

  function nouveauResultat() {
    return { plateforme: "", prompts: [], fanout: [], consultees: [], citees: [], _vus: {} };
  }
  function ajouteRequete(res, q) {
    q = (q || "").trim();
    if (q && !res._vus["q" + q]) { res._vus["q" + q] = 1; res.fanout.push(q); }
  }
  function ajouteSource(res, liste, url, titre) {
    if (!url || !/^https?:\/\//.test(url) || IGNORER.test(url)) return;
    url = sansSuivi(url);
    var cle = liste + url;
    if (res._vus[cle]) {
      var deja = res[liste].filter(function (s) { return s.url === url; })[0];
      if (deja && !deja.titre && titre) deja.titre = titre;
      return;
    }
    res._vus[cle] = 1;
    res[liste].push({ domaine: domaine(url), titre: (titre || "").replace(/\s+/g, " ").trim(), url: url });
  }

  // ---------------------------------------------------------------- ChatGPT
  // Connecté : flux SSE (lignes « data: {…} », correctifs « p / o / v »), champs search_model_queries, search_queries,
  // search_result_groups, content_references. Déconnecté (unauth-mweb, octobre 2026) : flux ndjson, sources dans
  // reasoning…searchSources (consultées) et content…references (citées) ; les fan-out ne sont pas transmis.
  function objetsJSON(texte) {
    var objets = [];
    var t = texte.trim();
    if (t[0] === "{" || t[0] === "[") { try { objets.push(JSON.parse(t)); return objets; } catch (e) {} }
    t.split(/\r?\n/).forEach(function (ligne) {
      ligne = ligne.trim();
      if (ligne.indexOf("data:") === 0) ligne = ligne.slice(5).trim();
      if (ligne[0] !== "{" && ligne[0] !== "[") return;
      try { objets.push(JSON.parse(ligne)); } catch (e) {}
    });
    return objets;
  }
  function parcourtChatGPT(x, chemin, res) {
    if (Array.isArray(x)) { x.forEach(function (v) { parcourtChatGPT(v, chemin, res); }); return; }
    if (!x || typeof x !== "object") return;
    if (typeof x.p === "string" && "v" in x) { parcourtChatGPT(x.v, chemin + x.p, res); }
    if (x.type === "search_model_queries" && Array.isArray(x.queries)) x.queries.forEach(function (q) { ajouteRequete(res, typeof q === "string" ? q : q && (q.q || q.query)); });
    if (Array.isArray(x.search_queries)) x.search_queries.forEach(function (q) { ajouteRequete(res, typeof q === "string" ? q : q && (q.q || q.query)); });
    if (/search_model_queries|search_queries/.test(chemin) && typeof x.q === "string") ajouteRequete(res, x.q);
    if (/search_model_queries\/queries/.test(chemin) && Array.isArray(x)) x.forEach(function (q) { ajouteRequete(res, q); });
    if (x.author && x.author.role === "user" && x.content && Array.isArray(x.content.parts)) {
      x.content.parts.forEach(function (p) { if (typeof p === "string" && p.trim() && res.prompts.indexOf(p.trim()) < 0) res.prompts.push(p.trim()); });
    }
    if (typeof x.url === "string") {
      if (/search_result_groups|searchSources/.test(chemin)) ajouteSource(res, "consultees", x.url, x.title || x.attribution);
      else if (/content_references|references|citations|sources_footnote/.test(chemin)) ajouteSource(res, "citees", x.url, x.title || x.source_label || x.attribution);
    }
    Object.keys(x).forEach(function (k) {
      if (k === "v" && typeof x.p === "string") return;
      var v = x[k];
      if (v && typeof v === "object") parcourtChatGPT(v, chemin + "/" + k, res);
      else if (k === "queries" && Array.isArray(v)) v.forEach(function (q) { ajouteRequete(res, q); });
    });
    // correctifs « append » sur la liste des requêtes : v est un tableau de chaînes
    if (typeof x.p === "string" && /search_model_queries/.test(x.p) && Array.isArray(x.v)) x.v.forEach(function (q) { if (typeof q === "string") ajouteRequete(res, q); });
  }
  function decodeChatGPT(texte, res) {
    res.plateforme = res.plateforme || "ChatGPT";
    objetsJSON(texte).forEach(function (o) { parcourtChatGPT(o, "", res); });
    // Toute page consultée qui est citée l'est aussi : on garde les citées en tête de la liste des consultées
    res.citees.forEach(function (s) { if (!res._vus["consultees" + s.url]) ajouteSource(res, "consultees", s.url, s.titre); });
  }

  // ---------------------------------------------------------------- Gemini
  // Depuis mi-octobre 2026, la réponse arrive par geminiweb-pa.clients6.google.com/v1/processSession : des trames
  // « [[n,["<protobuf en base64>"]]] ». Sources consultées (panneau « Recherche sur le Web effectuée ») : nœuds
  // { 1: icône gstatic, 2: URL, 3: titre }. Sources citées dans la réponse : { 1: URL, 2: titre, 4: extrait, 7: site }.
  function base64EnOctets(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s), o = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i);
    return o;
  }
  var utf8 = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8", { fatal: true }) : null;
  function protobuf(b, prof) {
    var p = 0, champs = [];
    function varint() {
      var r = 0, m = 1, c;
      do { if (p >= b.length) throw new Error("fin"); c = b[p++]; r += (c & 127) * m; m *= 128; } while (c & 128);
      return r;
    }
    while (p < b.length) {
      var cle = varint(), champ = Math.floor(cle / 8), type = cle % 8;
      if (champ === 0) throw new Error("champ");
      if (type === 0) champs.push([champ, varint()]);
      else if (type === 1) p += 8;
      else if (type === 5) p += 4;
      else if (type === 2) {
        var n = varint(), sous = b.subarray(p, p + n);
        p += n;
        if (p > b.length) throw new Error("longueur");
        var v = null;
        if (prof < 40 && n) { try { v = protobuf(sous, prof + 1); } catch (e) { v = null; } }
        if (v === null) { try { v = utf8.decode(sous); } catch (e) { v = ""; } }
        champs.push([champ, v]);
      } else throw new Error("type");
    }
    return champs;
  }
  function parcourtGemini(noeud, res) {
    if (!Array.isArray(noeud)) return;
    var s = {};
    noeud.forEach(function (c) { if (typeof c[1] === "string" && !(c[0] in s)) s[c[0]] = c[1]; });
    var estURL = function (x) { return typeof x === "string" && /^https?:\/\//.test(x); };
    if (estURL(s[1]) && /gstatic\.com\/favicon/.test(s[1]) && estURL(s[2]) && s[3]) ajouteSource(res, "consultees", s[2], s[3]);
    else if (estURL(s[1]) && !/gstatic|googleusercontent|google\.com\/maps/.test(s[1]) && s[2] && !estURL(s[2])) ajouteSource(res, "citees", s[1], s[2] + (s[7] ? " · " + s[7] : ""));
    noeud.forEach(function (c) { if (Array.isArray(c[1])) parcourtGemini(c[1], res); });
  }
  function decodeGemini(texte, res) {
    res.plateforme = res.plateforme || "Gemini";
    var trames = texte.match(/\[\[\d+,\["[A-Za-z0-9+\/=_-]{8,}"\]\]\]/g) || [];
    trames.forEach(function (t) {
      var b64 = t.slice(t.indexOf('["') + 2, t.lastIndexOf('"]'));
      try { parcourtGemini(protobuf(base64EnOctets(b64), 0), res); } catch (e) {}
    });
    res.citees.forEach(function (s) { if (!res._vus["consultees" + s.url]) ajouteSource(res, "consultees", s.url, s.titre.split(" · ")[0]); });
  }

  // ---------------------------------------------------------------- point d'entrée
  // texte : un export HAR (JSON), ou la réponse d'une requête de ChatGPT ou de Gemini copiée depuis F12.
  function analyse(texte) {
    var res = nouveauResultat();
    var t = (texte || "").trim();
    var har = null;
    if (t[0] === "{" && t.indexOf('"log"') >= 0) { try { har = JSON.parse(t); } catch (e) { har = null; } }
    if (har && har.log && Array.isArray(har.log.entries)) {
      har.log.entries.forEach(function (e) {
        var url = (e.request && e.request.url) || "", c = (e.response && e.response.content) || {};
        var corps = c.text || "";
        if (!corps) return;
        if (c.encoding === "base64") { try { corps = new TextDecoder("utf-8").decode(base64EnOctets(corps)); } catch (x) { return; } }
        if (/processSession|StreamGenerate/.test(url)) decodeGemini(corps, res);
        else if (/chatgpt\.com\/(backend-api|backend-anon|unauth-mweb)\/.*conversation/.test(url)) decodeChatGPT(corps, res);
      });
    } else if (/\[\[\d+,\["[A-Za-z0-9+\/=_-]{8,}"\]\]\]/.test(t)) decodeGemini(t, res);
    else decodeChatGPT(t, res);
    delete res._vus;
    return res;
  }
  // Tableau à coller dans Excel (tabulations)
  function versTSV(res) {
    var l = ["Type\tDomaine\tTitre\tURL"];
    res.fanout.forEach(function (q) { l.push("Fan-out\t\t" + q.replace(/\t/g, " ") + "\t"); });
    res.citees.forEach(function (s) { l.push("Source citée\t" + s.domaine + "\t" + s.titre.replace(/\t/g, " ") + "\t" + s.url); });
    res.consultees.forEach(function (s) { l.push("Source consultée\t" + s.domaine + "\t" + s.titre.replace(/\t/g, " ") + "\t" + s.url); });
    return l.join("\n");
  }
  racine.DecodeurGEO = { analyse: analyse, versTSV: versTSV, decodeChatGPT: decodeChatGPT, decodeGemini: decodeGemini, nouveauResultat: nouveauResultat };
})(typeof window !== "undefined" ? window : globalThis);
