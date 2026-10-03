<script lang="ts">
  import { onMount } from 'svelte';
  import { Map as MapLibre, type GeoJSONSource, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl';
  import { S2 } from 's2-geometry';
  import { selectedCellFeature, visibleLevels, worldGrid, zoomForFirstVisibleLevel, VISIBLE_LEVEL_COUNT } from './lib/s2';

  let mapElement: HTMLDivElement;
  let map: MapLibreMap | undefined;
  let basemap = 'light';
  let mobilePanelOpen = false;
  let zoom = 1.15;
  let activeLevels = visibleLevels(zoom);
  let hoveredCell = '';
  let cursorPosition = '';
  let selectedCell: {
    key: string;
    id: string;
    level: number;
    face: number;
    center: { lat: number; lng: number };
    lat: number;
    lng: number;
  } | null = null;

  const colors = ['#f06d43', '#e0a034', '#389887', '#5274c8', '#9864bd', '#c35c79'];
  const cellCounts = (level: number) => (6n * 4n ** BigInt(level)).toLocaleString('en-US');
  const protomapsApiKey = import.meta.env.VITE_PROTOMAPS_API_KEY?.trim();
  const styleUrl = () => protomapsApiKey
    ? `https://api.protomaps.com/styles/v5/${basemap}/en.json?key=${encodeURIComponent(protomapsApiKey)}`
    : `https://tiles.openfreemap.org/styles/${basemap === 'dark' ? 'dark' : 'positron'}`;

  function syncGrid() {
    if (!map?.getSource('s2-grid')) return;
    const source = map.getSource('s2-grid') as GeoJSONSource;
    source.setData(worldGrid(activeLevels, map) as never);
  }

  function addGridLayers() {
    if (!map || map.getSource('s2-grid')) return;
    map.addSource('s2-grid', {
      type: 'geojson',
      data: worldGrid(activeLevels, map) as never,
      tolerance: 0.15,
    });
    map.addSource('s2-selected', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    for (let level = 0; level <= 30; level += 1) {
      map.addLayer({
        id: `s2-grid-${level}`,
        type: 'line',
        source: 's2-grid',
        filter: ['==', ['get', 'level'], level],
        paint: {
          'line-color': colors[level % colors.length],
          'line-width': level === 0 ? 2.2 : level === 1 ? 1.6 : level === 2 ? 1.3 : 1.05,
          'line-opacity': level === 0 ? 0.94 : level === 1 ? 0.78 : 0.68,
        },
      });
    }
    map.addLayer({
      id: 's2-selected-fill',
      type: 'fill',
      source: 's2-selected',
      paint: { 'fill-color': '#f06d43', 'fill-opacity': 0.2 },
    });
    map.addLayer({
      id: 's2-selected-casing',
      type: 'line',
      source: 's2-selected',
      paint: { 'line-color': '#fffefa', 'line-width': 5, 'line-opacity': 0.95 },
    });
    map.addLayer({
      id: 's2-selected-outline',
      type: 'line',
      source: 's2-selected',
      paint: { 'line-color': '#e85f32', 'line-width': 2.5, 'line-opacity': 1 },
    });
    updateSelectedCellOverlay();
  }

  function updateSelectedCellOverlay() {
    const source = map?.getSource('s2-selected') as GeoJSONSource | undefined;
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: selectedCell
        ? [selectedCellFeature(selectedCell.lat, selectedCell.lng, selectedCell.level)]
        : [],
    } as never);
  }

  function setSelectedCell(lat: number, lng: number, level: number) {
    const key = S2.latLngToKey(lat, lng, level);
    const [face] = key.split('/');
    selectedCell = {
      key,
      id: S2.keyToId(key),
      level,
      face: Number(face),
      center: S2.keyToLatLng(key),
      lat,
      lng,
    };
    updateSelectedCellOverlay();
  }

  function selectCell(event: MapMouseEvent) {
    const { lat, lng } = event.lngLat;
    const finestLevel = activeLevels[activeLevels.length - 1];
    const finestKey = S2.latLngToKey(lat, lng, finestLevel);

    if (selectedCell?.level === finestLevel && selectedCell.key === finestKey) {
      if (selectedCell.level > 0) {
        const parentLevel = selectedCell.level - 1;
        setSelectedCell(lat, lng, parentLevel);
        zoomToLevel(parentLevel - 1, [lng, lat]);
      }
      return;
    }

    setSelectedCell(lat, lng, finestLevel);
  }

  function selectParentCell() {
    if (!selectedCell || selectedCell.level === 0) return;
    const { lat, lng, level } = selectedCell;
    setSelectedCell(lat, lng, level - 1);
    zoomToLevel(level - 2, [lng, lat]);
  }

  function clearSelectedCell() {
    selectedCell = null;
    updateSelectedCellOverlay();
  }

  function changeBasemap() {
    basemap = basemap === 'light' ? 'dark' : 'light';
    map?.setStyle(styleUrl());
  }

  function setZoom(next: number) {
    map?.easeTo({ zoom: Math.max(0, Math.min(20, next)), duration: 450 });
  }

  function zoomToLevel(level: number, center?: [number, number]) {
    const desiredFirst = Math.max(0, level - Math.max(0, VISIBLE_LEVEL_COUNT - 2));
    map?.easeTo({
      zoom: zoomForFirstVisibleLevel(desiredFirst),
      ...(center ? { center } : {}),
      duration: 450,
    });
  }

  function onPointerMove(event: MapMouseEvent) {
    const { lat, lng } = event.lngLat;
    const level = activeLevels[activeLevels.length - 1];
    hoveredCell = S2.latLngToKey(lat, lng, level);
    cursorPosition = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}  ${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`;
  }

  onMount(() => {
    const instance = new MapLibre({
      container: mapElement,
      style: styleUrl(),
      center: [12, 20],
      zoom,
      minZoom: 0,
      maxZoom: 20,
      attributionControl: false,
      renderWorldCopies: true,
      canvasContextAttributes: { antialias: true },
    });
    map = instance;
    instance.doubleClickZoom.disable();

    instance.on('load', addGridLayers);
    instance.on('style.load', () => {
      addGridLayers();
    });
    instance.on('zoom', () => {
      if (!map) return;
      zoom = map.getZoom();
      const nextLevels = visibleLevels(zoom);
      if (nextLevels.join(',') !== activeLevels.join(',')) {
        activeLevels = nextLevels;
        syncGrid();
      }
    });
    instance.on('moveend', syncGrid);
    instance.on('mousemove', onPointerMove);
    instance.on('click', selectCell);
    instance.on('mouseout', () => {
      hoveredCell = '';
      cursorPosition = '';
    });

    return () => map?.remove();
  });
</script>

<svelte:head>
  <title>S2 Grid Viewer</title>
</svelte:head>

<main class="app-shell">
  <div class="map-canvas" bind:this={mapElement}></div>
  <div class="map-wash"></div>

  <header class="topbar">
    <div class="brand-name">S2 Grid Viewer</div>
    <div class="top-actions">
      <button
        class="mobile-panel-toggle"
        class:panel-open={mobilePanelOpen}
        onclick={() => (mobilePanelOpen = !mobilePanelOpen)}
        aria-expanded={mobilePanelOpen}
        aria-controls="grid-panel"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        {mobilePanelOpen ? 'Close' : 'Levels'}
      </button>
      <button class="icon-button theme-button" onclick={changeBasemap} aria-label="Toggle map theme" title="Toggle map theme">
        {#if basemap === 'light'}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42m0-12.72-1.42 1.42m-9.88 9.88-1.42 1.42M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" /></svg>
        {:else}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 15.8A8.6 8.6 0 0 1 8.2 3.8 8.8 8.8 0 1 0 20.2 15.8Z" /></svg>
        {/if}
      </button>
    </div>
  </header>

  <aside id="grid-panel" class="explorer-panel" class:mobile-open={mobilePanelOpen}>
    <h1>World grid</h1>
    <p class="intro-copy">S2 cells organized by level.</p>

    <div class="panel-rule"></div>
    <div class="section-heading">
      <div><span class="section-label">VISIBLE LEVELS</span><span class="section-sub">Click a cell to inspect · click again for parent</span></div>
      <span class="resolution-count">{String(VISIBLE_LEVEL_COUNT).padStart(2, '0')} <span>/ 31</span></span>
    </div>

    <div class="resolution-list">
      {#each activeLevels as level, index}
        <button class="resolution-row" class:primary-level={index === activeLevels.length - 1} onclick={() => zoomToLevel(level)}>
          <span class="level-swatch" style={`--swatch:${colors[level % colors.length]}`}></span>
          <span class="level-name">Level <strong>{level}</strong></span>
          <span class="level-count">{cellCounts(level)} cells</span>
          <svg class="row-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10m-4-4 4 4-4 4" /></svg>
        </button>
      {/each}
    </div>

    {#if selectedCell}
      <section class="selected-cell" aria-live="polite">
        <div class="selected-cell-heading">
          <span>SELECTED CELL</span>
          <div class="selected-cell-actions">
            {#if selectedCell.level > 0}
              <button class="parent-cell-button" onclick={selectParentCell}>Parent cell</button>
            {/if}
            <button class="clear-cell-button" onclick={clearSelectedCell} aria-label="Clear selected cell">×</button>
          </div>
        </div>
        <div class="selected-cell-key">{selectedCell.key}</div>
        <div class="selected-cell-grid">
          <div><span>LEVEL</span><strong>{selectedCell.level}</strong></div>
          <div><span>FACE</span><strong>{selectedCell.face}</strong></div>
          <div class="center-detail">
            <span>CENTER</span>
            <strong>{selectedCell.center.lat.toFixed(5)}, {selectedCell.center.lng.toFixed(5)}</strong>
          </div>
        </div>
        <div class="selected-cell-id"><span>CELL ID</span><strong>{selectedCell.id}</strong></div>
      </section>
    {/if}

    <div class="zoom-nudge">
      <span class="nudge-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.3 4.3M10.8 7.5v6.6M7.5 10.8h6.6"/></svg></span>
      <span><strong>Scroll to zoom</strong><small>Finer levels appear as you zoom in</small></span>
    </div>

    <div class="panel-footer">
      <a href="https://s2geometry.io/" target="_blank" rel="noreferrer">S2 DOCUMENTATION <span>↗</span></a>
    </div>
  </aside>

  <div class="map-toolbar" aria-label="Map controls">
    <button onclick={() => setZoom(zoom + 1)} aria-label="Zoom in"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></button>
    <span class="toolbar-divider"></span>
    <button onclick={() => setZoom(zoom - 1)} aria-label="Zoom out"><svg viewBox="0 0 24 24"><path d="M5 12h14" /></svg></button>
    <span class="toolbar-divider"></span>
    <button onclick={() => map?.flyTo({ center: [12, 20], zoom: 1.15, duration: 650 })} aria-label="Reset map view" title="Reset view"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0 .1 2M20 4v7h-7" /></svg></button>
  </div>

  <div class="map-meta">
    {#if cursorPosition && hoveredCell}
      <div class="cursor-readout"><span class="readout-label">S2 CELL · L{activeLevels[activeLevels.length - 1]}</span><span class="readout-id">{hoveredCell}</span><span class="readout-coord">{cursorPosition}</span></div>
    {/if}
    <div class="map-credit"><span class="credit-mark">◈</span> {#if protomapsApiKey}<a href="https://protomaps.com/api" target="_blank" rel="noreferrer">Tiles: Protomaps</a> · {/if}<a href="https://openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a> · Grid: S2</div>
  </div>
</main>
