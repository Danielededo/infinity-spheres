# Infinity Spheres ∞

Una scena [Three.js](https://threejs.org/) in un **singolo file `index.html`**: 30 sfere solide, ognuna
di colore e tonalità differenti, scorrono lungo una **lemniscata di Bernoulli** urtandosi in modo
perfettamente elastico. Illuminazione e materiali `MeshPhysicalMaterial`, `OrbitControls`, animazione
in loop continuo.

**Demo:** https://danielededo.github.io/infinity-spheres/

Nessuna build, nessuna dipendenza da installare: Three.js arriva da CDN tramite un `importmap`.

---

## Come funziona

### La curva

Le sfere sono vincolate alla lemniscata di Bernoulli, in forma parametrica:

```
x(t) = a·cos t / (1 + sin²t)
z(t) = a·sin t·cos t / (1 + sin²t)
y(t) = lift·sin t
```

con `t ∈ [0, 2π)`, `a = 20` e `lift = 3.6`.

La lemniscata piana si **auto-interseca nell'origine** (per `t = π/2` e `t = 3π/2`): senza correzioni,
due sfere sui rami opposti si compenetrerebbero nel punto di incrocio. Il termine `y = lift·sin t`
separa i due rami in verticale — vale `+lift` su un ramo e `−lift` sull'altro — così la curva nello
spazio 3D non si interseca più, mentre la proiezione sul piano *xz* resta un ∞ perfetto. La distanza
minima tra rami distanti lungo la curva è **5.05 unità**, il doppio del diametro massimo di una sfera
(2.50), quindi il passaggio all'incrocio è sempre libero.

La curva è una sottoclasse di `THREE.Curve`, con `arcLengthDivisions = 4000`: `getPointAt(u)` restituisce
punti a **passo di arco costante**, non a passo di parametro costante. Senza questo accorgimento le sfere
rallenterebbero e accelererebbero artificialmente lungo i lobi. Il circuito misura **≈ 106.0 unità**.

### La fisica

Ogni sfera è una perlina infilata su un filo. Il suo stato è ridotto a due numeri:

- `u` — ascissa curvilinea normalizzata in `[0, 1)`
- `v` — velocità scalare lungo la curva, in unità/s (il segno dà il verso di marcia)

Il vincolo alla curva rende il problema **monodimensionale**: due sfere possono toccarsi solo se sono
adiacenti in `u`. Ad ogni frame le sfere vengono ordinate per `u` e si controllano le coppie vicine,
compresa quella che scavalca `u = 0`. Se la distanza d'arco scende sotto `r₁ + r₂` si applica l'urto
elastico 1D:

```
v₁' = ((m₁ − m₂)·v₁ + 2·m₂·v₂) / (m₁ + m₂)
v₂' = ((m₂ − m₁)·v₂ + 2·m₁·v₁) / (m₁ + m₂)
```

con massa proporzionale al volume (`m ∝ r³`). Lo scambio avviene solo se le due sfere si stanno
effettivamente avvicinando; segue una separazione posizionale ripartita in modo inversamente
proporzionale alle masse, per evitare che restino incastrate.

Su 120 s simulati (≈ 7000 urti) quantità di moto ed energia cinetica si conservano con deriva nulla
alla sesta cifra decimale: gli urti sono elastici in senso stretto, la simulazione non si smorza né
esplode.

**Sotto-passi.** Gli urti fra masse diverse redistribuiscono l'energia, e una sfera leggera può superare
i 35 unità/s. A velocità simili, con un passo di integrazione pieno, una sfera attraverserebbe la vicina
invece di urtarla. Il passo viene quindi suddiviso in modo che lo spostamento per sotto-passo resti sotto
mezzo raggio minimo (fino a 16 sotto-passi). Misurato al cursore velocità 3×: senza sotto-passi la
compenetrazione residua arriva a 1.35 unità (ben visibile), con i sotto-passi resta a 0.10.

### Resa

- Ambiente equirettangolare **generato a runtime** su `<canvas>` (gradiente + sorgenti luminose morbide)
  e convertito con `PMREMGenerator`: i materiali physical hanno riflessi credibili senza scaricare HDRI.
- `MeshPhysicalMaterial` per sfera, con `metalness`, `roughness`, `clearcoat` e `sheen` randomizzati:
  tutte diverse anche a parità di forma.
- Tonalità distribuite sull'intero cerchio cromatico (`hue = i/n`), con saturazione e luminosità variate.
- Luce principale con ombre `PCFSoft`, luce di stacco, due luci puntiformi colorate, nebbia esponenziale.
- `ACESFilmicToneMapping`, pixel ratio limitato a 2.

## Controlli

| Azione | Mouse / touch | Tastiera |
| --- | --- | --- |
| Orbita | trascina | — |
| Zoom | rotella / pizzica | — |
| Pan | tasto destro / due dita | — |
| Pausa | pulsante **Pausa** | <kbd>spazio</kbd> |
| Mostra percorso | pulsante **Percorso** | <kbd>P</kbd> |
| Auto-rotazione | pulsante **Rotazione** | <kbd>A</kbd> |
| Reset (nuovi colori e velocità) | pulsante **Reset** | <kbd>R</kbd> |
| Mostra/nascondi HUD | — | <kbd>H</kbd> |

Il cursore **Velocità** scala il tempo da 0 a 3×.

## Uso in locale

Il file usa i moduli ES, quindi va servito via HTTP (aprirlo con `file://` fa fallire il caricamento
dei moduli da CDN):

```bash
git clone https://github.com/danielededo/infinity-spheres.git
cd infinity-spheres
python3 -m http.server 8000
# poi apri http://localhost:8000
```

Serve una connessione a Internet per la CDN. Per un uso completamente offline, scarica Three.js
(`npm i three@0.169.0`) e fai puntare l'`importmap` in `index.html` alla copia locale.

## Personalizzazione

I parametri stanno tutti nell'oggetto `CONF` in cima allo script:

```js
const CONF = {
  spheres: 30,       // numero di sfere
  a: 20,             // semi-larghezza della lemniscata
  lift: 3.6,         // separazione verticale dei rami all'incrocio
  rMin: 0.55,        // raggio minimo
  rMax: 1.25,        // raggio massimo
  vMin: 2.0,         // velocità iniziale minima (unità/s)
  vMax: 7.5,         // velocità iniziale massima (unità/s)
  restitution: 1.0,  // 1 = urto perfettamente elastico
};
```

Due vincoli da rispettare:

- **`lift > rMax`**, altrimenti i rami tornano a toccarsi all'incrocio.
- **`somma dei diametri < lunghezza del circuito`** (≈ `5.24 · a`), altrimenti le sfere non ci stanno
  e la simulazione parte già compenetrata. Con i valori di default: 30 sfere occupano al massimo
  ≈ 54 unità su 106 disponibili.

Abbassando `restitution` sotto 1 gli urti diventano anelastici: le sfere perdono energia e finiscono
per accodarsi.

## Deploy su GitHub Pages

Il workflow [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) pubblica il contenuto della
repository su GitHub Pages ad ogni push sul branch di default, e può essere lanciato a mano da
**Actions → Deploy to GitHub Pages → Run workflow**.

Da fare una volta sola: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Licenza

[MIT](LICENSE).
