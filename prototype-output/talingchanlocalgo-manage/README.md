# PROTOTYPE output — talingchanlocalgo-manage

Throwaway sample for ticket #4. Source: https://www.talingchanlocal.go.th/manage.php

## Layout

- `content.json` — `{manifest, nodes}`; nodes in DOM order, `seq` = original position
- `images/NNN.ext` — downloaded files referenced by `nodes[].file`
- node types: `text` | `image` (+optional `fullres_candidate`) | `placeholder` (iframe) | `iframe-sameorigin`

## Stats

{
 "text": 134,
 "img": 17,
 "placeholder": 0,
 "cutChromeImg": 97,
 "cutNoise": 4,
 "cutBlankFrame": 2,
 "imgErrors": 0
}

## React to this (owner)

1. Layout/file naming OK?
2. `region` per node useful or noise?
3. Placeholder shape enough for downstream systems?
