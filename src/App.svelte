<script lang="ts">
  import { onMount } from 'svelte';
  import { Map as MapLibre, type GeoJSONSource, type Map as MapLibreMap, type MapMouseEvent } from 'maplibre-gl';
  import { S2 } from 's2-geometry';
  import { selectedCellFeature, visibleLevels, worldGrid, zoomForFirstVisibleLevel, VISIBLE_LEVEL_COUNT } from './lib/s2';

  let mapElement: HTMLDivElement;
  let map: MapLibreMap | undefined;
  let basemap = 'light';
  let projection: 'mercator' | 'globe' = 'mercator';
  let mobilePanelOpen = false;
  let mobileSearchOpen = false;
  let searchQuery = '';
  let searchError = '';
  let copiedFormat: 'token' | 'decimal' | 'key' | null = null;
  let zoom = 1.15;
  let activeLevels = visibleLevels(zoom);
  let levelRows: Array<HTMLButtonElement | undefined> = [];
  let hoveredCell: ReturnType<typeof cellDetailsFromKey> | null = null;
  let hoveredLocation: [number, number] | null = null;
  let selectedCell: {
    key: string;
    id: string;
    token: string;
    level: number;
    face: number;
    center: { lat: number; lng: number };
    lat: number;
    lng: number;
  } | null = null;

  const coordinateSearchZoom = 10;
  const allLevels = Array.from({ length: 31 }, (_, level) => level);
  const rootFaceCenters = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 90 },
    { lat: 90, lng: 0 },
    { lat: 0, lng: 180 },
    { lat: 0, lng: -90 },
    { lat: -90, lng: 0 },
  ];

  const colors = ['#f06d43', '#e0a034', '#389887', '#5274c8', '#9864bd', '#c35c79'];
  const cellCounts = (level: number) => (6n * 4n ** BigInt(level)).toLocaleString('en-US');
  const protomapsApiKey = import.meta.env.VITE_PROTOMAPS_API_KEY?.trim();
  const styleUrl = () => protomapsApiKey
    ? `https://api.protomaps.com/styles/v5/${basemap}/en.json?key=${encodeURIComponent(protomapsApiKey)}`
    : `https://tiles.openfreemap.org/styles/${basemap === 'dark' ? 'dark' : 'positron'}`;

  function cellDetailsFromKey(key: string) {
    const match = /^([0-5])\/([0-3]{0,30})$/.exec(key);
    if (!match) throw new Error('Invalid S2 cell key');
    const face = Number(match[1]);
    const position = match[2];
    const level = position.length;
    const id = level === 0
      ? ((BigInt(face) << 61n) | (1n << 60n)).toString()
      : S2.keyToId(key);
    const token = BigInt(id).toString(16).padStart(16, '0').replace(/0+$/, '');
    const center = level === 0 ? rootFaceCenters[face] : S2.keyToLatLng(key);
    return { key, id, token, level, face, center };
  }

  function cellDetailsFromToken(token: string) {
    if (!/^[\da-f]{1,16}$/i.test(token)) throw new Error('Invalid S2 token');
    return cellDetailsFromId(BigInt(`0x${token.padEnd(16, '0')}`));
  }

  function cellDetailsFromId(id: bigint) {
    if (id <= 0n || id > (1n << 64n) - 1n) throw new Error('Invalid S2 cell ID');
    let leastSignificantBit = 0;
    while ((id & (1n << BigInt(leastSignificantBit))) === 0n && leastSignificantBit < 64) {
      leastSignificantBit += 1;
    }
    if (leastSignificantBit > 60 || leastSignificantBit % 2 !== 0) {
      throw new Error('Invalid S2 cell ID');
    }

    const face = Number(id >> 61n);
    if (face > 5) throw new Error('Invalid S2 cell ID');
    const level = 30 - leastSignificantBit / 2;
    const key = level === 0 ? `${face}/` : S2.idToKey(id.toString());
    const details = cellDetailsFromKey(key);
    if (BigInt(details.id) !== id) throw new Error('Invalid S2 cell ID');
    return details;
  }

  function parseSearchQuery(value: string) {
    const query = value.trim();
    if (/^[0-5]\/[0-3]{0,30}$/.test(query)) {
      return { type: 'cell' as const, cell: cellDetailsFromKey(query) };
    }

    if (/^id:\d+$/i.test(query)) {
      return { type: 'cell' as const, cell: cellDetailsFromId(BigInt(query.slice(3))) };
    }

    if (/^\d+$/.test(query) && query.length > 16) {
      return { type: 'cell' as const, cell: cellDetailsFromId(BigInt(query)) };
    }

    if (/^0x[\da-f]{1,16}$/i.test(query)) {
      return { type: 'cell' as const, cell: cellDetailsFromId(BigInt(query)) };
    }

    if (/^[\da-f]{1,16}$/i.test(query)) {
      return { type: 'cell' as const, cell: cellDetailsFromToken(query) };
    }

    const coordinates = query.replace(/^\(|\)$/g, '').match(/^(-?(?:\d+\.?\d*|\.\d+))\s*(?:,|\/|\s)\s*(-?(?:\d+\.?\d*|\.\d+))$/);
    if (!coordinates) throw new Error('Enter an S2 ID, S2 token, S2 key, or latitude and longitude');
    const lat = Number(coordinates[1]);
    const lng = Number(coordinates[2]);
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new Error('Latitude must be -90 to 90 and longitude -180 to 180');
    }
    return { type: 'coordinates' as const, lat, lng };
  }

  function applySearchQuery(value: string, updateHash = true) {
    try {
      const result = parseSearchQuery(value);
      searchError = '';
      searchQuery = value;

      if (result.type === 'cell') {
        const { center, level } = result.cell;
        setSelectedCell(center.lat, center.lng, level);
        const firstLevel = Math.max(0, level - (VISIBLE_LEVEL_COUNT - 1));
        map?.easeTo({
          center: [center.lng, center.lat],
          zoom: Math.min(20, zoomForFirstVisibleLevel(firstLevel)),
          duration: 650,
        });
      } else {
        const level = visibleLevels(coordinateSearchZoom).at(-1)!;
        setSelectedCell(result.lat, result.lng, level);
        map?.easeTo({ center: [result.lng, result.lat], zoom: coordinateSearchZoom, duration: 650 });
      }

      if (updateHash) syncSelectedCellHash(true);
      mobileSearchOpen = false;
    } catch (error) {
      searchError = error instanceof Error ? error.message : 'Invalid search';
    }
  }

  function handleSearchSubmit(event: SubmitEvent) {
    event.preventDefault();
    applySearchQuery(searchQuery);
  }

  function readSearchFromHash() {
    const query = new URLSearchParams(location.hash.slice(1)).get('q');
    if (query) {
      searchQuery = query;
      applySearchQuery(query, false);
    } else {
      searchQuery = '';
      searchError = '';
      clearSelectedCell();
    }
  }

  async function copyIdentifier(value: string, format: 'token' | 'decimal' | 'key') {
    try {
      await navigator.clipboard.writeText(value);
      copiedFormat = format;
      window.setTimeout(() => {
        if (copiedFormat === format) copiedFormat = null;
      }, 1400);
    } catch {
      copiedFormat = null;
    }
  }

  function syncSelectedCellHash(pushHistory = false) {
    if (!selectedCell) return;
    const query = selectedCell.token;
    searchQuery = query;
    const hash = `#${new URLSearchParams({ q: query }).toString()}`;
    if (location.hash === hash) return;
    const url = `${location.pathname}${location.search}${hash}`;
    if (pushHistory) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  }

  function toggleMobilePanel() {
    mobilePanelOpen = !mobilePanelOpen;
    if (mobilePanelOpen) mobileSearchOpen = false;
    if (mobilePanelOpen && selectedCell) scrollLevelIntoView(selectedCell.level);
  }

  function toggleMobileSearch() {
    mobileSearchOpen = !mobileSearchOpen;
    if (mobileSearchOpen) mobilePanelOpen = false;
  }

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
    map.addSource('s2-hovered', {
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
      id: 's2-hovered-fill',
      type: 'fill',
      source: 's2-hovered',
      paint: { 'fill-color': '#4386a5', 'fill-opacity': 0.12 },
    });
    map.addLayer({
      id: 's2-hovered-outline',
      type: 'line',
      source: 's2-hovered',
      paint: { 'line-color': '#347f9a', 'line-width': 1.5, 'line-opacity': 0.9 },
    });
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
    updateHoveredCellOverlay();
    updateSelectedCellOverlay();
  }

  function updateHoveredCellOverlay() {
    const source = map?.getSource('s2-hovered') as GeoJSONSource | undefined;
    if (!source) return;
    source.setData({
      type: 'FeatureCollection',
      features: hoveredCell && hoveredLocation
        ? [selectedCellFeature(hoveredLocation[0], hoveredLocation[1], hoveredCell.level)]
        : [],
    } as never);
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
    const details = cellDetailsFromKey(key);
    selectedCell = {
      ...details,
      lat,
      lng,
    };
    copiedFormat = null;
    updateSelectedCellOverlay();
    scrollLevelIntoView(level);
  }

  function scrollLevelIntoView(level: number) {
    requestAnimationFrame(() => levelRows[level]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  function selectCell(event: MapMouseEvent) {
    const { lat, lng } = event.lngLat;
    if (selectedCell && S2.latLngToKey(lat, lng, selectedCell.level) === selectedCell.key) {
      clearSelectedCell();
      return;
    }
    const finestLevel = activeLevels[activeLevels.length - 1];
    setSelectedCell(lat, lng, finestLevel);
    syncSelectedCellHash();
  }

  function onPointerMove(event: MapMouseEvent) {
    const { lat, lng } = event.lngLat;
    const key = S2.latLngToKey(lat, lng, activeLevels[activeLevels.length - 1]);
    if (hoveredCell?.key !== key) {
      hoveredCell = cellDetailsFromKey(key);
      hoveredLocation = [lat, lng];
      updateHoveredCellOverlay();
    }
  }

  function selectVisibleLevel(level: number) {
    if (!selectedCell) {
      zoomToLevel(level);
      return;
    }
    const { lat, lng } = selectedCell;
    setSelectedCell(lat, lng, level);
    syncSelectedCellHash();
    zoomToLevel(level, [lng, lat]);
  }

  function clearSelectedCell() {
    selectedCell = null;
    searchQuery = '';
    searchError = '';
    updateSelectedCellOverlay();
    if (new URLSearchParams(location.hash.slice(1)).has('q')) {
      history.replaceState(null, '', `${location.pathname}${location.search}`);
    }
  }

  function changeBasemap() {
    basemap = basemap === 'light' ? 'dark' : 'light';
    map?.setStyle(styleUrl());
  }

  function toggleProjection() {
    projection = projection === 'mercator' ? 'globe' : 'mercator';
    map?.setProjection({ type: projection });
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

    instance.on('load', addGridLayers);
    instance.on('style.load', () => {
      addGridLayers();
      instance.setProjection({ type: projection });
    });
    instance.on('zoom', () => {
      if (!map) return;
      zoom = map.getZoom();
      const nextLevels = visibleLevels(zoom);
      if (nextLevels.join(',') !== activeLevels.join(',')) {
        activeLevels = nextLevels;
        syncGrid();
        if (selectedCell) scrollLevelIntoView(selectedCell.level);
      }
    });
    instance.on('moveend', syncGrid);
    instance.on('click', selectCell);
    instance.on('mousemove', onPointerMove);
    instance.on('mouseout', () => {
      hoveredCell = null;
      hoveredLocation = null;
      updateHoveredCellOverlay();
    });

    window.addEventListener('popstate', readSearchFromHash);
    window.addEventListener('hashchange', readSearchFromHash);
    if (location.hash) readSearchFromHash();

    return () => {
      window.removeEventListener('popstate', readSearchFromHash);
      window.removeEventListener('hashchange', readSearchFromHash);
      map?.remove();
    };
  });
</script>

<svelte:head>
  <title>S2 Grid Viewer</title>
</svelte:head>

<main class="app-shell" class:dark-mode={basemap === 'dark'}>
  <div class="map-canvas" bind:this={mapElement}></div>
  <div class="map-wash"></div>

  <header class="topbar">
    <div class="brand-group">
      <div class="brand-name">S2 Grid Viewer</div>
      <a
        class="icon-button repo-link"
        href="https://github.com/lecafard/s2viewer"
        target="_blank"
        rel="noreferrer"
        aria-label="S2 Viewer on GitHub"
        title="S2 Viewer on GitHub"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.55.1.76-.24.76-.54v-2.1c-3.1.67-3.75-1.32-3.75-1.32-.5-1.29-1.24-1.63-1.24-1.63-1.01-.69.08-.68.08-.68 1.12.08 1.71 1.15 1.71 1.15 1 .1.76 2.01 3.34 1.43.1-.72.39-1.21.7-1.49-2.48-.28-5.09-1.24-5.09-5.52 0-1.22.44-2.22 1.15-3-.12-.28-.5-1.42.11-2.96 0 0 .94-.3 3.05 1.15a10.6 10.6 0 0 1 5.55 0c2.12-1.44 3.05-1.15 3.05-1.15.61 1.54.23 2.68.11 2.96.72.78 1.15 1.78 1.15 3 0 4.29-2.61 5.24-5.1 5.51.4.35.75 1.03.75 2.08v3.08c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z"/></svg>
      </a>
    </div>
    <form
      id="location-search"
      class="location-search"
      class:mobile-search-open={mobileSearchOpen}
      onsubmit={handleSearchSubmit}
    >
      <input
        bind:value={searchQuery}
        oninput={() => (searchError = '')}
        aria-label="S2 cell ID, S2 key, or latitude and longitude"
        placeholder="S2 ID, token, key, or lat, lon"
        spellcheck="false"
      />
      <button type="submit" aria-label="Search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.3 4.3"/></svg>
      </button>
      {#if searchError}
        <div class="search-error" role="alert">{searchError}</div>
      {/if}
    </form>
    <div class="top-actions">
      <button
        class="mobile-search-toggle"
        class:search-open={mobileSearchOpen}
        onclick={toggleMobileSearch}
        aria-expanded={mobileSearchOpen}
        aria-controls="location-search"
        aria-label={mobileSearchOpen ? 'Close search' : 'Open search'}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.3 4.3"/></svg>
      </button>
      <button
        class="mobile-panel-toggle"
        class:panel-open={mobilePanelOpen}
        onclick={toggleMobilePanel}
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
      <button
        class="icon-button projection-button"
        class:projection-active={projection === 'globe'}
        onclick={toggleProjection}
        aria-label={projection === 'globe' ? 'Switch to flat map' : 'Switch to globe'}
        aria-pressed={projection === 'globe'}
        title={projection === 'globe' ? 'Switch to flat map' : 'Switch to globe'}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" /></svg>
      </button>
    </div>
  </header>

  <aside id="grid-panel" class="explorer-panel" class:mobile-open={mobilePanelOpen}>
    <h1>World grid</h1>
    <p class="intro-copy">S2 cells organized by level.</p>

    <div class="panel-rule"></div>
    <div class="section-heading">
      <div><span class="section-label">S2 LEVELS</span><span class="section-sub">Select a level to focus the grid</span></div>
      <span class="resolution-count">{String(VISIBLE_LEVEL_COUNT).padStart(2, '0')} <span>/ 31</span></span>
    </div>

    <div class="resolution-list">
      {#each allLevels as level}
        <button
          bind:this={levelRows[level]}
          class="resolution-row"
          class:visible-level={activeLevels.includes(level)}
          class:selected-level={selectedCell?.level === level}
          aria-pressed={selectedCell?.level === level}
          onclick={() => selectVisibleLevel(level)}
        >
          <span class="level-swatch" style={`--swatch:${colors[level % colors.length]}`}></span>
          <span class="level-name">Level <strong>{level}</strong></span>
          {#if selectedCell?.level === level}<span class="selected-level-marker" aria-hidden="true"></span>{/if}
          <span class="level-count">{cellCounts(level)} cells</span>
          <svg class="row-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10m-4-4 4 4-4 4" /></svg>
        </button>
      {/each}
    </div>

    <div class="panel-footer">
      <a href="https://s2geometry.io/" target="_blank" rel="noreferrer">S2 DOCUMENTATION <span>↗</span></a>
    </div>
  </aside>

  {#if selectedCell}
    <section
      class="selected-cell-context"
      class:levels-open={mobilePanelOpen}
      class:search-open={mobileSearchOpen}
      aria-live="polite"
      aria-label="Selected S2 cell details"
    >
      <div class="selected-cell-heading">
        <span>SELECTED CELL</span>
        <div class="selected-cell-actions">
          <button class="clear-cell-button" onclick={clearSelectedCell} aria-label="Clear selected cell">×</button>
        </div>
      </div>
      <button
        class="selected-cell-key"
        onclick={() => selectedCell && copyIdentifier(selectedCell.key, 'key')}
        aria-label="Copy S2 face and position key"
        title="Copy S2 key"
      >
        <span>{copiedFormat === 'key' ? 'COPIED' : 'S2 KEY · FACE/POSITION'}</span>
        <strong>{selectedCell.key}</strong>
      </button>
      <div class="selected-cell-grid">
        <div><span>LEVEL</span><strong>{selectedCell.level}</strong></div>
        <div><span>FACE</span><strong>{selectedCell.face}</strong></div>
        <div class="center-detail">
          <span>CENTER</span>
          <strong>{selectedCell.center.lat.toFixed(5)}, {selectedCell.center.lng.toFixed(5)}</strong>
        </div>
      </div>
      <div class="selected-cell-identifiers">
        <button class="identifier-copy" onclick={() => selectedCell && copyIdentifier(selectedCell.token, 'token')} aria-label="Copy S2 token">
          <span>{copiedFormat === 'token' ? 'COPIED' : 'S2 TOKEN'}</span><strong>{selectedCell.token}</strong>
        </button>
        <button class="identifier-copy" onclick={() => selectedCell && copyIdentifier(selectedCell.id, 'decimal')} aria-label="Copy decimal S2 cell ID">
          <span>{copiedFormat === 'decimal' ? 'COPIED' : 'DECIMAL ID'}</span><strong>{selectedCell.id}</strong>
        </button>
      </div>
    </section>
  {/if}

  <div class="map-toolbar" aria-label="Map controls">
    <button onclick={() => setZoom(zoom + 1)} aria-label="Zoom in"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" /></svg></button>
    <span class="toolbar-divider"></span>
    <button onclick={() => setZoom(zoom - 1)} aria-label="Zoom out"><svg viewBox="0 0 24 24"><path d="M5 12h14" /></svg></button>
    <span class="toolbar-divider"></span>
    <button onclick={() => map?.flyTo({ center: [12, 20], zoom: 1.15, duration: 650 })} aria-label="Reset map view" title="Reset view"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0 .1 2M20 4v7h-7" /></svg></button>
  </div>

  <div class="map-meta">
    {#if hoveredCell}
      <div class="hover-readout" aria-live="polite">
        <div class="hover-readout-heading"><span>HOVERED CELL</span><span>LEVEL {hoveredCell.level} · FACE {hoveredCell.face}</span></div>
        <strong>{hoveredCell.token}</strong>
        <small>{hoveredCell.center.lat.toFixed(5)}, {hoveredCell.center.lng.toFixed(5)}</small>
      </div>
    {/if}
    <div class="map-credit"><span class="credit-mark">◈</span> {#if protomapsApiKey}<a href="https://protomaps.com/api" target="_blank" rel="noreferrer">Tiles: Protomaps</a> · {/if}<a href="https://openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a> · Grid: S2</div>
  </div>
</main>
