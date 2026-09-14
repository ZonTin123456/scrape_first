# PROTOTYPE output — wanganggo-manage

Throwaway sample for ticket #4. Source: https://www.wangang.go.th/manage.php

## Layout

- `content.json` — `{manifest, nodes}`; nodes in DOM order, `seq` = original position
- `images/NNN.ext` — downloaded files referenced by `nodes[].file`
- node types: `text` | `image` (+optional `fullres_candidate`) | `placeholder` (iframe) | `iframe-sameorigin`

## Stats

{
 "text": 162,
 "img": 154,
 "placeholder": 1,
 "cutChromeImg": 0,
 "cutNoise": 0,
 "cutBlankFrame": 0,
 "imgErrors": 0
}

## React to this (owner)

1. Layout/file naming OK?
2. `region` per node useful or noise?
3. Placeholder shape enough for downstream systems?
