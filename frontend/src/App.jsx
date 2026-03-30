import React, { useEffect, useMemo, useState } from "react";
import maplibregl from "maplibre-gl";
import { useI18n } from "./i18n/I18nContext.jsx";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const DEFAULT_MAP_STYLE =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";
const PAGE_SIZE = 10;

function extractPointCoordinates(list) {
  return list
    .map((place) => place?.geometry?.coordinates)
    .filter(
      (coords) =>
        Array.isArray(coords) &&
        coords.length >= 2 &&
        typeof coords[0] === "number" &&
        typeof coords[1] === "number" &&
        !Number.isNaN(Number(coords[0])) &&
        !Number.isNaN(Number(coords[1]))
    )
    .map((coords) => [Number(coords[0]), Number(coords[1])]);
}

function walkLngLatCoords(coords, visit) {
  if (!coords) return;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    visit(Number(coords[0]), Number(coords[1]));
    return;
  }
  if (Array.isArray(coords)) {
    coords.forEach((c) => walkLngLatCoords(c, visit));
  }
}

function placesToFeatureCollection(places) {
  const features = [];
  for (const place of places) {
    if (!place?.id || !place.geometry?.type) continue;
    const coll = String(place?.properties?.collection ?? "").trim();
    features.push({
      type: "Feature",
      properties: {
        placeId: place.id,
        name: place?.properties?.name || "Unnamed place",
        collection: coll
      },
      geometry: {
        type: place.geometry.type,
        coordinates: place.geometry.coordinates
      }
    });
  }
  return { type: "FeatureCollection", features };
}

function boundsFromPlaces(places) {
  const bounds = new maplibregl.LngLatBounds();
  let n = 0;
  for (const place of places) {
    walkLngLatCoords(place?.geometry?.coordinates, (lng, lat) => {
      if (!Number.isNaN(lng) && !Number.isNaN(lat)) {
        bounds.extend([lng, lat]);
        n += 1;
      }
    });
  }
  return n > 0 ? bounds : null;
}

function normalizeHexColor(input) {
  let s = String(input ?? "").trim();
  if (!s) return "#64748b";
  if (!s.startsWith("#")) s = `#${s}`;
  if (/^#[0-9A-Fa-f]{3}$/.test(s)) {
    const r = s[1];
    const g = s[2];
    const b = s[3];
    s = `#${r}${r}${g}${g}${b}${b}`;
  }
  if (!/^#[0-9A-Fa-f]{6}$/.test(s)) return "";
  return s.toLowerCase();
}

function buildColorMatchFromRegistry(managedList) {
  const flat = [];
  for (const c of managedList) {
    const n = String(c.name ?? "").trim();
    if (!n) continue;
    const col = normalizeHexColor(c.color) || "#64748b";
    flat.push(n, col);
  }
  return ["match", ["get", "collection"], ...flat, "#94a3b8"];
}

function buildHiddenCollectionFilter(hiddenKeys) {
  if (!hiddenKeys || hiddenKeys.length === 0) return null;
  const parts = hiddenKeys.map((c) => ["==", ["get", "collection"], c]);
  return ["!", ["any", ...parts]];
}

function combineLayerFilter(geomFilter, hiddenFilter) {
  if (!hiddenFilter) return geomFilter;
  return ["all", geomFilter, hiddenFilter];
}

const mapPlaceNameTextField = [
  "case",
  ["has", "name"],
  ["to-string", ["get", "name"]],
  "Unnamed place"
];

const mapPlaceLabelPaint = {
  "text-color": "#0f172a",
  "text-halo-color": "rgba(255,255,255,0.98)",
  "text-halo-width": 4,
  "text-halo-blur": 1.1
};

const mapLineWidthByZoom = [
  "interpolate",
  ["linear"],
  ["zoom"],
  5,
  3,
  10,
  5.5,
  14,
  8
];

const mapLineCasingWidthByZoom = [
  "interpolate",
  ["linear"],
  ["zoom"],
  5,
  8,
  10,
  12,
  14,
  16
];

function nearestPointPlace(lng, lat, places) {
  let nearest = null;
  for (const place of places) {
    if (place?.geometry?.type !== "Point") continue;
    const coords = place.geometry.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const pLng = Number(coords[0]);
    const pLat = Number(coords[1]);
    if (Number.isNaN(pLng) || Number.isNaN(pLat)) continue;
    const meters = distanceMeters(lat, lng, pLat, pLng);
    if (!nearest || meters < nearest.meters) {
      nearest = { place, meters };
    }
  }
  return nearest;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function summarizeCoordsCell(geometry) {
  if (!geometry?.type) return "-";
  if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
    const a = geometry.coordinates[0];
    const b = geometry.coordinates[1];
    if (typeof a === "number" && typeof b === "number") {
      return `${a}, ${b}`;
    }
  }
  return geometry.type;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadius * c;
}

function toastId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function App() {
  const { t, lang, setLang } = useI18n();
  const tRef = React.useRef(t);
  tRef.current = t;

  const [places, setPlaces] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [viewMode, setViewMode] = useState("table");
  const [currentPage, setCurrentPage] = useState(1);
  const [totalRecords, setTotalRecords] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [selectedPlaceId, setSelectedPlaceId] = useState("");
  const [form, setForm] = useState({
    name: "",
    collection: "",
    geometryType: "Point",
    lng: "",
    lat: "",
    coordsJson: ""
  });
  const [editingId, setEditingId] = useState("");
  const [toasts, setToasts] = useState([]);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [importFile, setImportFile] = useState(null);
  const [importing, setImporting] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [filterInput, setFilterInput] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  const [managedCollections, setManagedCollections] = useState([]);
  const [mapPlaces, setMapPlaces] = useState([]);
  const [registryDraft, setRegistryDraft] = useState([]);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [newCollectionColor, setNewCollectionColor] = useState("#2563eb");
  const [collDeleteTarget, setCollDeleteTarget] = useState(null);
  const [mapStyleReady, setMapStyleReady] = useState(false);
  const [hiddenMapCollections, setHiddenMapCollections] = useState([]);
  const mapContainerRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const managedCollectionsRef = React.useRef([]);
  managedCollectionsRef.current = managedCollections;
  const draftMarkerRef = React.useRef(null);
  const clickPopupRef = React.useRef(null);
  const selectionPopupRef = React.useRef(null);
  const mapPlacesRef = React.useRef(mapPlaces);
  const createPlaceFromMapRef = React.useRef(async () => {});

  mapPlacesRef.current = mapPlaces;

  const apiUrl = useMemo(
    () => (API_BASE_URL ? `${API_BASE_URL}/api/places` : ""),
    []
  );
  const exportUrl = useMemo(
    () => (API_BASE_URL ? `${API_BASE_URL}/api/places/export` : ""),
    []
  );
  const importUrl = useMemo(
    () => (API_BASE_URL ? `${API_BASE_URL}/api/places/import` : ""),
    []
  );
  const bulkDeleteUrl = useMemo(
    () => (API_BASE_URL ? `${API_BASE_URL}/api/places/bulk-delete` : ""),
    []
  );
  const registryCollectionsUrl = useMemo(
    () => (API_BASE_URL ? `${API_BASE_URL}/api/collections` : ""),
    []
  );

  const distinctCollectionKeys = useMemo(() => {
    const s = new Set();
    managedCollections.forEach((c) => {
      s.add(String(c.name ?? "").trim());
    });
    mapPlaces.forEach((p) => {
      s.add(String(p?.properties?.collection ?? "").trim());
    });
    return Array.from(s).sort((a, b) => {
      if (a === "") return -1;
      if (b === "") return 1;
      return a.localeCompare(b);
    });
  }, [managedCollections, mapPlaces]);

  const mapCollectionColorByName = useMemo(() => {
    const m = {};
    for (const c of managedCollections) {
      const n = String(c.name ?? "").trim();
      if (n) m[n] = normalizeHexColor(c.color) || "#64748b";
    }
    return m;
  }, [managedCollections]);

  useEffect(() => {
    setRegistryDraft(managedCollections);
  }, [managedCollections]);

  function showToast(message, kind = "info") {
    const id = toastId();
    setToasts((prev) => [...prev, { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 2500);
  }

  async function loadMapPlacesForQuery(q) {
    if (!API_BASE_URL) return;
    try {
      const params = new URLSearchParams();
      if (String(q ?? "").trim()) {
        params.set("q", String(q).trim());
      }
      const qs = params.toString();
      const url = qs
        ? `${API_BASE_URL}/api/places/map?${qs}`
        : `${API_BASE_URL}/api/places/map`;
      const response = await fetch(url);
      if (!response.ok) return;
      const json = await response.json();
      if (Array.isArray(json.data)) {
        setMapPlaces(json.data);
      }
    } catch {
      /* ignore */
    }
  }

  async function loadPlaces(targetPage = currentPage, filterOverride, opts = {}) {
    const skipMapRefresh = opts.skipMapRefresh === true;
    const q = filterOverride !== undefined ? filterOverride : appliedFilter;
    setLoading(true);
    setError("");
    if (!apiUrl) {
      setLoading(false);
      setError(t("toast.missingApi"));
      return;
    }
    try {
      const params = new URLSearchParams({
        page: String(targetPage),
        limit: String(PAGE_SIZE)
      });
      if (q.trim()) {
        params.set("q", q.trim());
      }
      const response = await fetch(`${apiUrl}?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      const json = await response.json();
      const nextPlaces = Array.isArray(json.data) ? json.data : [];
      const nextTotal = Number(json.total ?? nextPlaces.length ?? 0);
      const nextLimit = Number(json.limit ?? PAGE_SIZE);
      const computedTotalPages =
        nextLimit > 0 ? Math.ceil(nextTotal / nextLimit) : 0;
      const serverPage = Number(json.page ?? targetPage);

      if (computedTotalPages > 0 && serverPage > computedTotalPages) {
        await loadPlaces(computedTotalPages, q, opts);
        return;
      }

      setPlaces(nextPlaces);
      setCurrentPage(serverPage);
      setTotalRecords(nextTotal);
      setTotalPages(Number(json.totalPages ?? computedTotalPages));
      if (!skipMapRefresh) {
        void loadMapPlacesForQuery(q);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function handleExport(format) {
    if (!exportUrl) {
      setError(t("toast.missingApi"));
      showToast(t("toast.missingApi"), "error");
      return;
    }
    try {
      const params = new URLSearchParams({ format });
      if (selectedIds.length > 0) {
        params.set("ids", selectedIds.join(","));
      }
      const response = await fetch(`${exportUrl}?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Export failed: ${response.status}`);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `places.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
      const target =
        selectedIds.length > 0 ? t("toast.exportSelected") : t("toast.exportAll");
      showToast(t("toast.exported", { format: format.toUpperCase(), target }), "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      showToast(msg, "error");
    }
  }

  async function deleteSelected() {
    if (!bulkDeleteUrl) {
      setError(t("toast.missingApi"));
      showToast(t("toast.missingApi"), "error");
      return;
    }
    if (selectedIds.length === 0) {
      showToast(t("toast.pickRecords"), "info");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(bulkDeleteUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: selectedIds })
      });
      if (!response.ok) {
        throw new Error(`Delete selected failed: ${response.status}`);
      }
      const payload = await response.json();
      const deleted = Number(payload.deleted || 0);
      showToast(t("toast.deletedN", { n: deleted }), "success");
      setSelectedIds([]);
      await fetchManagedCollections();
      await loadPlaces(currentPage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  }

  function toggleSelect(id, checked) {
    setSelectedIds((prev) => {
      if (checked) {
        if (prev.includes(id)) return prev;
        return [...prev, id];
      }
      return prev.filter((v) => v !== id);
    });
  }

  function toggleSelectCurrentPage(checked) {
    const pageIds = places.map((place) => place.id).filter(Boolean);
    setSelectedIds((prev) => {
      const set = new Set(prev);
      if (checked) {
        pageIds.forEach((id) => set.add(id));
      } else {
        pageIds.forEach((id) => set.delete(id));
      }
      return Array.from(set);
    });
  }

  const currentPageIds = places.map((place) => place.id).filter(Boolean);
  const allCurrentPageSelected =
    currentPageIds.length > 0 && currentPageIds.every((id) => selectedIds.includes(id));

  async function handleImport() {
    if (!importUrl) {
      setError(t("toast.missingApi"));
      showToast(t("toast.missingApi"), "error");
      return;
    }
    if (!importFile) {
      showToast(t("toast.pickFile"), "error");
      return;
    }

    const lower = importFile.name.toLowerCase();
    const format = lower.endsWith(".xlsx") ? "xlsx" : "csv";

    const formData = new FormData();
    formData.append("file", importFile);

    setImporting(true);
    setError("");
    try {
      const response = await fetch(`${importUrl}?format=${format}`, {
        method: "POST",
        body: formData
      });
      if (!response.ok) {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const payload = await response.json();
          throw new Error(payload.error || `Import failed: ${response.status}`);
        }
        throw new Error(`Import failed: ${response.status}`);
      }
      const payload = await response.json();
      const inserted = Number(payload.inserted || 0);
      showToast(t("toast.importedN", { n: inserted }), "success");
      setImportFile(null);
      await fetchManagedCollections();
      await loadPlaces(1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setImporting(false);
    }
  }

  async function submitPlace(event) {
    if (event && typeof event.preventDefault === "function") {
      event.preventDefault();
    }
    if (!apiUrl) {
      setError(t("toast.missingApi"));
      showToast(t("toast.missingApi"), "error");
      return;
    }
    if (!form.name.trim()) {
      setError(t("toast.nameRequired"));
      showToast(t("toast.nameRequired"), "error");
      return;
    }

    let geometry;
    if (form.geometryType === "Point") {
      const lng = Number(form.lng);
      const lat = Number(form.lat);
      if (Number.isNaN(lng) || Number.isNaN(lat)) {
        setError(t("toast.lngLatInvalid"));
        showToast(t("toast.lngLatInvalid"), "error");
        return;
      }
      geometry = { type: "Point", coordinates: [lng, lat] };
    } else {
      let parsed;
      try {
        parsed = JSON.parse(form.coordsJson.trim());
      } catch {
        setError(t("toast.coordsInvalid"));
        showToast(t("toast.coordsInvalid"), "error");
        return;
      }
      geometry = { type: form.geometryType, coordinates: parsed };
    }

    const properties = { name: form.name.trim() };
    const coll = form.collection.trim();
    if (coll) {
      properties.collection = coll;
    }

    setSubmitting(true);
    setError("");
    const isEdit = Boolean(editingId);
    try {
      const method = editingId ? "PATCH" : "POST";
      const url = editingId ? `${apiUrl}/${editingId}` : apiUrl;
      const body = editingId
        ? { properties, geometry }
        : {
            type: "Feature",
            geometry,
            properties
          };

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        throw new Error(`Save failed: ${response.status}`);
      }
      setForm({
        name: "",
        collection: "",
        geometryType: "Point",
        lng: "",
        lat: "",
        coordsJson: ""
      });
      setEditingId("");
      setShowAddForm(false);
      if (draftMarkerRef.current) {
        draftMarkerRef.current.remove();
        draftMarkerRef.current = null;
      }
      if (clickPopupRef.current) {
        clickPopupRef.current.remove();
        clickPopupRef.current = null;
      }
      showToast(isEdit ? t("toast.placeUpdated") : t("toast.placeCreated"), "success");
      await fetchManagedCollections();
      if (isEdit) {
        await loadPlaces(currentPage);
      } else {
        await loadPlaces(1);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(place) {
    setShowAddForm(false);
    setEditingId(place.id);
    const gType = place?.geometry?.type || "Point";
    let lng = "";
    let lat = "";
    let coordsJson = "";
    if (gType === "Point" && Array.isArray(place?.geometry?.coordinates)) {
      lng = String(place.geometry.coordinates[0] ?? "");
      lat = String(place.geometry.coordinates[1] ?? "");
    } else {
      try {
        coordsJson = JSON.stringify(place.geometry.coordinates, null, 2);
      } catch {
        coordsJson = "";
      }
    }
    setForm({
      name: place?.properties?.name || "",
      collection: String(place?.properties?.collection ?? "").trim(),
      geometryType: gType === "LineString" || gType === "Polygon" ? gType : "Point",
      lng,
      lat,
      coordsJson
    });
  }

  function cancelEdit() {
    setEditingId("");
    setShowAddForm(false);
    setForm({
      name: "",
      collection: "",
      geometryType: "Point",
      lng: "",
      lat: "",
      coordsJson: ""
    });
    if (draftMarkerRef.current) {
      draftMarkerRef.current.remove();
      draftMarkerRef.current = null;
    }
    if (clickPopupRef.current) {
      clickPopupRef.current.remove();
      clickPopupRef.current = null;
    }
  }

  async function deletePlace(placeId) {
    if (!apiUrl) {
      setError(t("toast.missingApi"));
      showToast(t("toast.missingApi"), "error");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(`${apiUrl}/${placeId}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error(`Delete failed: ${response.status}`);
      }
      if (editingId === placeId) {
        cancelEdit();
      }
      showToast(t("toast.placeDeleted"), "success");
      await fetchManagedCollections();
      await loadPlaces(currentPage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      showToast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    await deletePlace(deleteTarget.id);
    setDeleteTarget(null);
  }

  function cancelDelete() {
    setDeleteTarget(null);
    showToast(t("toast.deleteCancelled"), "info");
  }

  function showOnMap(place) {
    if (!place?.id) return;
    setSelectedPlaceId(place.id);
    setViewMode("map");
    showToast(
      t("toast.showOnMap", {
        name: place?.properties?.name || t("toast.genericPlace")
      }),
      "info"
    );
  }

  function changeViewMode(mode) {
    setViewMode(mode);
    setSelectedPlaceId("");
    if (draftMarkerRef.current) {
      draftMarkerRef.current.remove();
      draftMarkerRef.current = null;
    }
    if (clickPopupRef.current) {
      clickPopupRef.current.remove();
      clickPopupRef.current = null;
    }
    if (selectionPopupRef.current) {
      selectionPopupRef.current.remove();
      selectionPopupRef.current = null;
    }
  }

  async function fetchManagedCollections() {
    if (!registryCollectionsUrl) return;
    try {
      const response = await fetch(registryCollectionsUrl);
      if (!response.ok) return;
      const json = await response.json();
      if (Array.isArray(json.data)) {
        setManagedCollections(json.data);
      }
    } catch {
      /* ignore */
    }
  }

  async function syncCollectionsFromPlaces() {
    if (!API_BASE_URL) {
      showToast(t("toast.missingApi"), "error");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/collections/sync-from-places`, {
        method: "POST"
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Sync failed: ${response.status}`);
      }
      showToast(t("toast.collectionsSynced"), "success");
      await fetchManagedCollections();
      await loadPlaces(currentPage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      showToast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    fetchManagedCollections();
  }, [registryCollectionsUrl]);

  function updateCollectionDraft(id, patch) {
    setRegistryDraft((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function saveCollectionRow(row) {
    if (!registryCollectionsUrl) {
      showToast(t("toast.missingApi"), "error");
      return;
    }
    const name = String(row.name ?? "").trim();
    const color = normalizeHexColor(row.color);
    if (!name) {
      showToast(t("toast.collNameRequired"), "error");
      return;
    }
    if (!color) {
      showToast(t("toast.colorHex"), "error");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(`${registryCollectionsUrl}/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Save failed: ${response.status}`);
      }
      showToast(t("toast.collSaved"), "success");
      await fetchManagedCollections();
      await loadPlaces(currentPage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      showToast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddManagedCollection() {
    if (!registryCollectionsUrl) {
      showToast(t("toast.missingApi"), "error");
      return;
    }
    const name = newCollectionName.trim();
    const color = normalizeHexColor(newCollectionColor);
    if (!name) {
      showToast(t("toast.collNameRequired"), "error");
      return;
    }
    if (!color) {
      showToast(t("toast.colorHex"), "error");
      return;
    }
    setSubmitting(true);
    try {
      const response = await fetch(registryCollectionsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Add failed: ${response.status}`);
      }
      setNewCollectionName("");
      setNewCollectionColor("#2563eb");
      showToast(t("toast.collCreated"), "success");
      await fetchManagedCollections();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      showToast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmCollectionDelete() {
    if (!collDeleteTarget || !registryCollectionsUrl) return;
    setSubmitting(true);
    try {
      const response = await fetch(`${registryCollectionsUrl}/${collDeleteTarget.id}`, {
        method: "DELETE"
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Delete failed: ${response.status}`);
      }
      showToast(t("toast.collDeleted"), "success");
      setCollDeleteTarget(null);
      await fetchManagedCollections();
      await loadPlaces(currentPage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      showToast(msg, "error");
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    setCurrentPage(1);
    setFilterInput("");
    setAppliedFilter("");
    loadPlaces(1, "");
  }, [apiUrl]);

  function goToPage(nextPage) {
    if (loading || submitting) return;
    if (nextPage < 1 || (totalPages > 0 && nextPage > totalPages)) return;
    if (editingId) {
      setEditingId("");
      setForm({
        name: "",
        collection: "",
        geometryType: "Point",
        lng: "",
        lat: "",
        coordsJson: ""
      });
    }
    loadPlaces(nextPage, undefined, { skipMapRefresh: true });
  }

  function applyNameFilter() {
    const next = filterInput.trim();
    setAppliedFilter(next);
    loadPlaces(1, next);
  }

  function clearNameFilter() {
    setFilterInput("");
    setAppliedFilter("");
    loadPlaces(1, "");
  }

  function toggleMapCollectionVisibility(key) {
    setHiddenMapCollections((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]
    );
  }

  function openAddForm() {
    setEditingId("");
    setForm({
      name: "",
      collection: "",
      geometryType: "Point",
      lng: "",
      lat: "",
      coordsJson: ""
    });
    setShowAddForm(true);
  }

  createPlaceFromMapRef.current = async (lng, lat, name, collection = "") => {
    if (!apiUrl) {
      showToast(t("toast.missingApi"), "error");
      return false;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      showToast(t("toast.enterName"), "error");
      return false;
    }
    const props = { name: trimmed };
    const c = String(collection).trim();
    if (c) {
      props.collection = c;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "Feature",
          geometry: { type: "Point", coordinates: [lng, lat] },
          properties: props
        })
      });
      if (!response.ok) {
        throw new Error(`Save failed: ${response.status}`);
      }
      showToast(t("toast.placeCreated"), "success");
      await fetchManagedCollections();
      await loadPlaces(1);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      showToast(msg, "error");
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (viewMode !== "map") return;
    if (!mapContainerRef.current) return;
    if (mapRef.current) return;

    const points = extractPointCoordinates(mapPlacesRef.current);
    const initialCenter = points.length > 0 ? points[0] : [100.5018, 13.7563];
    const initialZoom = points.length > 0 ? 10 : 5;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: DEFAULT_MAP_STYLE,
      center: initialCenter,
      zoom: initialZoom
    });
    mapRef.current = map;
    let cancelled = false;

    const handleMapClick = (event) => {
      const tt = tRef.current;
      const layersHit = ["places-poly-fill", "places-line", "places-point"];
      const picked = map.queryRenderedFeatures(event.point, { layers: layersHit });
      if (picked.length > 0) {
        const props = picked[0].properties || {};
        const title = props.name || tt("map.defaultName");
        const coll = props.collection
          ? String(props.collection)
          : tt("map.uncategorized");
        new maplibregl.Popup({ offset: 12, closeButton: true })
          .setLngLat(event.lngLat)
          .setHTML(
            `<div class="map-hit-popup"><strong>${escapeHtml(title)}</strong><br/>${escapeHtml(coll)}</div>`
          )
          .addTo(map);
        return;
      }

      const lng = Number(event.lngLat.lng.toFixed(6));
      const lat = Number(event.lngLat.lat.toFixed(6));

      const nearest = nearestPointPlace(lng, lat, mapPlacesRef.current);
      const isExactExistingPoint = nearest && nearest.meters <= 8;
      if (clickPopupRef.current) {
        clickPopupRef.current.remove();
      }

      if (isExactExistingPoint) {
        if (draftMarkerRef.current) {
          draftMarkerRef.current.remove();
          draftMarkerRef.current = null;
        }
        showToast(tt("toast.clickExisting"), "info");
        return;
      }

      if (draftMarkerRef.current) {
        draftMarkerRef.current.remove();
      }
      const draftEl = document.createElement("div");
      draftEl.className = "map-marker map-marker-draft";
      draftMarkerRef.current = new maplibregl.Marker({ element: draftEl })
        .setLngLat([lng, lat])
        .addTo(map);

      const container = document.createElement("div");
      container.className = "map-popup-add";

      const coordsLine = document.createElement("p");
      coordsLine.className = "map-popup-coords";
      coordsLine.textContent = tt("map.coordsLine", { lat, lng });

      const input = document.createElement("input");
      input.type = "text";
      input.className = "map-popup-input";
      input.placeholder = tt("form.placeName");
      input.setAttribute("autocomplete", "off");

      const collLabel = document.createElement("label");
      collLabel.className = "map-popup-label";
      collLabel.textContent = tt("map.popup.collection");
      const collInput = document.createElement("select");
      collInput.className = "map-popup-select";
      const optEmpty = document.createElement("option");
      optEmpty.value = "";
      optEmpty.textContent = tt("form.optNone");
      collInput.appendChild(optEmpty);
      managedCollectionsRef.current.forEach((c) => {
        const o = document.createElement("option");
        o.value = c.name;
        o.textContent = c.name;
        collInput.appendChild(o);
      });
      collInput.value = "";

      const actions = document.createElement("div");
      actions.className = "map-popup-actions";

      const btnCancel = document.createElement("button");
      btnCancel.type = "button";
      btnCancel.className = "map-popup-btn map-popup-btn-cancel";
      btnCancel.textContent = tt("form.cancel");

      const btnAdd = document.createElement("button");
      btnAdd.type = "button";
      btnAdd.className = "map-popup-btn map-popup-btn-primary";
      btnAdd.textContent = tt("form.add");

      actions.appendChild(btnCancel);
      actions.appendChild(btnAdd);
      container.appendChild(coordsLine);
      container.appendChild(input);
      container.appendChild(collLabel);
      container.appendChild(collInput);
      container.appendChild(actions);

      const clearDraft = () => {
        if (draftMarkerRef.current) {
          draftMarkerRef.current.remove();
          draftMarkerRef.current = null;
        }
      };

      const closePopup = () => {
        if (clickPopupRef.current) {
          clickPopupRef.current.remove();
          clickPopupRef.current = null;
        }
        clearDraft();
      };

      btnCancel.addEventListener("click", closePopup);

      btnAdd.addEventListener("click", async () => {
        const ok = await createPlaceFromMapRef.current(lng, lat, input.value, collInput.value || "");
        if (!ok) return;
        if (clickPopupRef.current) {
          clickPopupRef.current.remove();
        }
      });

      const popup = new maplibregl.Popup({
        offset: 20,
        closeButton: true,
        closeOnClick: false
      })
        .setLngLat([lng, lat])
        .setDOMContent(container)
        .addTo(map);

      clickPopupRef.current = popup;
      popup.on("close", () => {
        clearDraft();
        clickPopupRef.current = null;
      });

      window.setTimeout(() => {
        input.focus();
      }, 0);
    };

    map.once("load", () => {
      if (cancelled) return;
      map.addSource("places", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "placeId"
      });
      map.addLayer({
        id: "places-poly-fill",
        type: "fill",
        source: "places",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
          "fill-color": "#64748b",
          "fill-opacity": 0.68,
          "fill-outline-color": "#0f172a"
        }
      });
      map.addLayer({
        id: "places-line-casing",
        type: "line",
        source: "places",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": mapLineCasingWidthByZoom,
          "line-opacity": 0.95
        }
      });
      map.addLayer({
        id: "places-line",
        type: "line",
        source: "places",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#64748b",
          "line-width": mapLineWidthByZoom
        }
      });
      map.addLayer({
        id: "places-point",
        type: "circle",
        source: "places",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
          "circle-radius": 7,
          "circle-color": "#64748b",
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#ffffff"
        }
      });
      map.addLayer({
        id: "places-poly-label",
        type: "symbol",
        source: "places",
        filter: ["==", ["geometry-type"], "Polygon"],
        layout: {
          "symbol-placement": "line-center",
          "text-field": mapPlaceNameTextField,
          "text-font": ["Noto Sans Regular", "Arial Unicode MS Regular"],
          "text-size": 12,
          "text-padding": 4,
          "text-rotation-alignment": "viewport",
          "text-pitch-alignment": "viewport",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "text-optional": false,
          "symbol-avoid-edges": false,
          "symbol-z-order": "source"
        },
        paint: mapPlaceLabelPaint
      });
      map.addLayer({
        id: "places-line-label",
        type: "symbol",
        source: "places",
        filter: ["==", ["geometry-type"], "LineString"],
        layout: {
          "symbol-placement": "line-center",
          "text-field": mapPlaceNameTextField,
          "text-font": ["Noto Sans Regular", "Arial Unicode MS Regular"],
          "text-size": 12,
          "text-padding": 4,
          "text-rotation-alignment": "viewport",
          "text-pitch-alignment": "viewport",
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "text-optional": false,
          "symbol-avoid-edges": false,
          "symbol-z-order": "source"
        },
        paint: mapPlaceLabelPaint
      });
      map.addLayer({
        id: "places-point-label",
        type: "symbol",
        source: "places",
        filter: ["==", ["geometry-type"], "Point"],
        layout: {
          "text-field": mapPlaceNameTextField,
          "text-font": ["Noto Sans Regular", "Arial Unicode MS Regular"],
          "text-offset": [0, 1.35],
          "text-anchor": "top",
          "text-size": 12,
          "text-padding": 4,
          "text-allow-overlap": true,
          "text-ignore-placement": true,
          "symbol-z-order": "source"
        },
        paint: mapPlaceLabelPaint
      });
      map.on("click", handleMapClick);
      if (!cancelled) {
        setMapStyleReady(true);
      }
    });

    return () => {
      cancelled = true;
      setMapStyleReady(false);
      if (mapRef.current) {
        mapRef.current.off("click", handleMapClick);
      }
      if (draftMarkerRef.current) {
        draftMarkerRef.current.remove();
        draftMarkerRef.current = null;
      }
      if (clickPopupRef.current) {
        clickPopupRef.current.remove();
        clickPopupRef.current = null;
      }
      if (selectionPopupRef.current) {
        selectionPopupRef.current.remove();
        selectionPopupRef.current = null;
      }
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [viewMode]);

  function syncMapPlaceLayers(map) {
    const colorExpr = buildColorMatchFromRegistry(managedCollections);
    const hiddenFilter = buildHiddenCollectionFilter(hiddenMapCollections);
    const fPoly = combineLayerFilter(["==", ["geometry-type"], "Polygon"], hiddenFilter);
    const fLine = combineLayerFilter(["==", ["geometry-type"], "LineString"], hiddenFilter);
    const fPoint = combineLayerFilter(["==", ["geometry-type"], "Point"], hiddenFilter);

    map.setFilter("places-poly-fill", fPoly);
    map.setFilter("places-line-casing", fLine);
    map.setFilter("places-line", fLine);
    map.setFilter("places-point", fPoint);
    map.setFilter("places-poly-label", fPoly);
    map.setFilter("places-line-label", fLine);
    map.setFilter("places-point-label", fPoint);

    map.setPaintProperty("places-poly-fill", "fill-color", colorExpr);
    map.setPaintProperty("places-line", "line-color", colorExpr);
    map.setPaintProperty("places-point", "circle-color", colorExpr);
  }

  useEffect(() => {
    if (viewMode !== "map" || !mapStyleReady || !mapRef.current) return;
    const map = mapRef.current;
    const src = map.getSource("places");
    if (!src || typeof src.setData !== "function") return;

    const fc = placesToFeatureCollection(mapPlaces);
    src.setData(fc);
    syncMapPlaceLayers(map);

    const b = boundsFromPlaces(mapPlaces);
    if (b) {
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      const span = Math.max(Math.abs(ne.lng - sw.lng), Math.abs(ne.lat - sw.lat));
      if (span < 1e-10) {
        map.flyTo({ center: [sw.lng, sw.lat], zoom: 13 });
      } else {
        map.fitBounds(b, { padding: 60, maxZoom: 14 });
      }
    }
  }, [mapPlaces, viewMode, mapStyleReady]);

  useEffect(() => {
    if (viewMode !== "map" || !mapStyleReady || !mapRef.current) return;
    const map = mapRef.current;
    if (!map.getSource("places")) return;
    syncMapPlaceLayers(map);
  }, [hiddenMapCollections, managedCollections, viewMode, mapStyleReady]);

  useEffect(() => {
    if (viewMode !== "map" || !mapStyleReady || !selectedPlaceId || !mapRef.current) return;
    const target =
      mapPlaces.find((place) => place.id === selectedPlaceId) ||
      places.find((place) => place.id === selectedPlaceId);
    if (!target?.geometry) return;

    const map = mapRef.current;
    const b = boundsFromPlaces([target]);
    if (!b) return;

    if (selectionPopupRef.current) {
      selectionPopupRef.current.remove();
      selectionPopupRef.current = null;
    }

    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    const span = Math.max(Math.abs(ne.lng - sw.lng), Math.abs(ne.lat - sw.lat));
    if (span < 1e-10) {
      map.flyTo({ center: [sw.lng, sw.lat], zoom: 14 });
    } else {
      map.fitBounds(b, { padding: 80, maxZoom: 15 });
    }

    const name = target.properties?.name || t("map.defaultName");
    const coll = target.properties?.collection
      ? String(target.properties.collection)
      : t("map.uncategorized");
    const center = b.getCenter();
    const popup = new maplibregl.Popup({ offset: 14, closeButton: true })
      .setLngLat(center)
      .setHTML(
        `<div class="map-hit-popup"><strong>${escapeHtml(name)}</strong><br/>${escapeHtml(coll)}</div>`
      )
      .addTo(map);
    selectionPopupRef.current = popup;
  }, [mapPlaces, places, selectedPlaceId, viewMode, mapStyleReady, lang, t]);

  return (
    <main className="page">
      <div className="toast-container">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            {toast.message}
          </div>
        ))}
      </div>
      <header className="header">
        <h1>{t("header.title")}</h1>
        <div className="lang-switch" role="group" aria-label={t("lang.label")}>
          <button
            type="button"
            className={lang === "th" ? "active" : ""}
            onClick={() => setLang("th")}
          >
            {t("lang.th")}
          </button>
          <button
            type="button"
            className={lang === "en" ? "active" : ""}
            onClick={() => setLang("en")}
          >
            {t("lang.en")}
          </button>
        </div>
      </header>

      <section className="panel">
        {deleteTarget && (
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <div className="modal-card">
              <h3>{t("modal.deletePlace")}</h3>
              <p>
                {t("modal.deletePlaceLead")}{" "}
                <strong>{deleteTarget.name || t("modal.thisPlace")}</strong>
                {t("modal.deletePlaceTrail")}
              </p>
              <div className="modal-actions">
                <button type="button" onClick={cancelDelete} disabled={submitting}>
                  {t("modal.cancel")}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={confirmDelete}
                  disabled={submitting}
                >
                  {t("modal.delete")}
                </button>
              </div>
            </div>
          </div>
        )}

        {collDeleteTarget && (
          <div className="modal-backdrop" role="dialog" aria-modal="true">
            <div className="modal-card">
              <h3>{t("modal.deleteColl")}</h3>
              <p>{t("modal.deleteCollBody", { name: collDeleteTarget.name })}</p>
              <div className="modal-actions">
                <button
                  type="button"
                  onClick={() => setCollDeleteTarget(null)}
                  disabled={submitting}
                >
                  {t("modal.cancel")}
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={confirmCollectionDelete}
                  disabled={submitting}
                >
                  {t("modal.delete")}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="view-switch">
          <button
            type="button"
            className={viewMode === "table" ? "active" : ""}
            onClick={() => changeViewMode("table")}
          >
            {t("view.table")}
          </button>
          <button
            type="button"
            className={viewMode === "map" ? "active" : ""}
            onClick={() => changeViewMode("map")}
          >
            {t("view.map")}
          </button>
          <button
            type="button"
            className={viewMode === "collections" ? "active" : ""}
            onClick={() => changeViewMode("collections")}
          >
            {t("view.collections")}
          </button>
        </div>

        {loading && <p>{t("loading")}</p>}
        {error && (
          <p className="error">
            {t("error.prefix")}
            {error}
          </p>
        )}
        {viewMode === "table" && (
          <>
            <div className="panel-title">
              <h2>{t("places.title")}</h2>
              <button
                type="button"
                className="btn-primary"
                onClick={openAddForm}
                disabled={loading || submitting || !!editingId}
              >
                {t("places.addPlace")}
              </button>
            </div>
            <div className="filter-row">
              <input
                type="search"
                className="filter-input"
                placeholder={t("places.searchPlaceholder")}
                value={filterInput}
                onChange={(e) => setFilterInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyNameFilter();
                }}
                disabled={loading || submitting}
              />
              <button type="button" onClick={applyNameFilter} disabled={loading || submitting}>
                {t("places.search")}
              </button>
              <button type="button" onClick={clearNameFilter} disabled={loading || submitting}>
                {t("places.clear")}
              </button>
            </div>
            <div className="data-tools">
              <div className="export-tools">
                <button type="button" onClick={() => handleExport("csv")} disabled={loading || submitting || importing}>
                  {t("places.exportCsv")}
                </button>
                <button type="button" onClick={() => handleExport("xlsx")} disabled={loading || submitting || importing}>
                  {t("places.exportXlsx")}
                </button>
                <button type="button" onClick={deleteSelected} disabled={loading || submitting || importing || selectedIds.length === 0}>
                  {t("places.deleteSelected", { n: selectedIds.length })}
                </button>
              </div>
              <div className="import-tools">
                <input
                  type="file"
                  accept=".csv,.xlsx"
                  onChange={(e) => setImportFile(e.target.files?.[0] || null)}
                  disabled={loading || submitting || importing}
                />
                <button type="button" onClick={handleImport} disabled={loading || submitting || importing}>
                  {importing ? t("places.importing") : t("places.importFile")}
                </button>
              </div>
            </div>
            {showAddForm && !editingId && (
              <form className="place-form place-form-extended" onSubmit={submitPlace}>
                <input
                  type="text"
                  placeholder={t("form.placeName")}
                  value={form.name}
                  onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                />
                <select
                  value={form.collection}
                  onChange={(e) => setForm((prev) => ({ ...prev, collection: e.target.value }))}
                  aria-label={t("form.collectionAria")}
                >
                  <option value="">{t("form.optNone")}</option>
                  {form.collection &&
                    !managedCollections.some((c) => c.name === form.collection) && (
                      <option value={form.collection}>
                        {form.collection} {t("form.unlisted")}
                      </option>
                    )}
                  {managedCollections.map((c) => (
                    <option key={c.id} value={c.name}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select
                  value={form.geometryType}
                  onChange={(e) => setForm((prev) => ({ ...prev, geometryType: e.target.value }))}
                  aria-label={t("form.geometryAria")}
                >
                  <option value="Point">{t("form.geom.point")}</option>
                  <option value="LineString">{t("form.geom.line")}</option>
                  <option value="Polygon">{t("form.geom.poly")}</option>
                </select>
                {form.geometryType === "Point" ? (
                  <>
                    <input
                      type="number"
                      step="any"
                      placeholder={t("form.lng")}
                      value={form.lng}
                      onChange={(e) => setForm((prev) => ({ ...prev, lng: e.target.value }))}
                    />
                    <input
                      type="number"
                      step="any"
                      placeholder={t("form.lat")}
                      value={form.lat}
                      onChange={(e) => setForm((prev) => ({ ...prev, lat: e.target.value }))}
                    />
                  </>
                ) : (
                  <textarea
                    className="place-form-coords"
                    rows={4}
                    placeholder={
                      form.geometryType === "LineString"
                        ? t("form.coordsLinePh")
                        : t("form.coordsPolyPh")
                    }
                    value={form.coordsJson}
                    onChange={(e) => setForm((prev) => ({ ...prev, coordsJson: e.target.value }))}
                  />
                )}
                <button type="submit" disabled={submitting}>
                  {t("form.add")}
                </button>
                <button type="button" onClick={cancelEdit} disabled={submitting}>
                  {t("form.cancel")}
                </button>
              </form>
            )}
            <p className="map-help">{t("table.tip")}</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={allCurrentPageSelected}
                        onChange={(e) => toggleSelectCurrentPage(e.target.checked)}
                      />
                    </th>
                    <th>{t("table.thName")}</th>
                    <th>{t("table.thCollection")}</th>
                    <th>{t("table.thGeometry")}</th>
                    <th>{t("table.thCoordinates")}</th>
                    <th>{t("table.thActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {places.length === 0 && (
                    <tr>
                      <td colSpan={6}>{t("table.empty")}</td>
                    </tr>
                  )}
                  {places.map((place) => {
                    const isRowEdit = editingId === place.id;
                    return (
                      <tr key={place.id} className={isRowEdit ? "table-row-editing" : undefined}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(place.id)}
                            onChange={(e) => toggleSelect(place.id, e.target.checked)}
                            disabled={submitting || isRowEdit}
                          />
                        </td>
                        <td>
                          {isRowEdit ? (
                            <input
                              type="text"
                              className="table-inline-input"
                              value={form.name}
                              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                              disabled={submitting}
                            />
                          ) : (
                            place?.properties?.name || "-"
                          )}
                        </td>
                        <td>
                          {isRowEdit ? (
                            <select
                              className="table-inline-select"
                              value={form.collection}
                              onChange={(e) => setForm((prev) => ({ ...prev, collection: e.target.value }))}
                              disabled={submitting}
                              aria-label={t("form.collectionAria")}
                            >
                              <option value="">{t("form.optNone")}</option>
                              {form.collection &&
                                !managedCollections.some((c) => c.name === form.collection) && (
                                  <option value={form.collection}>
                                    {form.collection} {t("form.unlisted")}
                                  </option>
                                )}
                              {managedCollections.map((c) => (
                                <option key={c.id} value={c.name}>
                                  {c.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            String(place?.properties?.collection ?? "").trim() || "-"
                          )}
                        </td>
                        <td>
                          {isRowEdit ? (
                            <select
                              className="table-inline-select"
                              value={form.geometryType}
                              onChange={(e) => setForm((prev) => ({ ...prev, geometryType: e.target.value }))}
                              disabled={submitting}
                              aria-label={t("form.geometryAria")}
                            >
                              <option value="Point">{t("form.geom.point")}</option>
                              <option value="LineString">{t("form.geom.line")}</option>
                              <option value="Polygon">{t("form.geom.poly")}</option>
                            </select>
                          ) : (
                            place?.geometry?.type || "-"
                          )}
                        </td>
                        <td>
                          {isRowEdit ? (
                            form.geometryType === "Point" ? (
                              <div className="table-inline-ll">
                                <input
                                  type="number"
                                  step="any"
                                  className="table-inline-input table-inline-input-narrow"
                                  placeholder={t("form.lngShort")}
                                  value={form.lng}
                                  onChange={(e) => setForm((prev) => ({ ...prev, lng: e.target.value }))}
                                  disabled={submitting}
                                />
                                <input
                                  type="number"
                                  step="any"
                                  className="table-inline-input table-inline-input-narrow"
                                  placeholder={t("form.latShort")}
                                  value={form.lat}
                                  onChange={(e) => setForm((prev) => ({ ...prev, lat: e.target.value }))}
                                  disabled={submitting}
                                />
                              </div>
                            ) : (
                              <textarea
                                className="table-inline-coords"
                                rows={3}
                                value={form.coordsJson}
                                onChange={(e) => setForm((prev) => ({ ...prev, coordsJson: e.target.value }))}
                                disabled={submitting}
                              />
                            )
                          ) : (
                            summarizeCoordsCell(place.geometry)
                          )}
                        </td>
                        <td className="actions">
                          {isRowEdit ? (
                            <>
                              <button type="button" onClick={() => submitPlace()} disabled={submitting}>
                                {t("form.save")}
                              </button>
                              <button type="button" onClick={cancelEdit} disabled={submitting}>
                                {t("form.cancel")}
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => showOnMap(place)}
                                disabled={submitting || (!!editingId && editingId !== place.id)}
                              >
                                {t("table.showOnMap")}
                              </button>
                              <button
                                type="button"
                                onClick={() => startEdit(place)}
                                disabled={submitting || (!!editingId && editingId !== place.id) || showAddForm}
                              >
                                {t("table.edit")}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setDeleteTarget({
                                    id: place.id,
                                    name: place?.properties?.name || ""
                                  })
                                }
                                disabled={submitting || !!editingId}
                              >
                                {t("table.delete")}
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                {t("pagination.showing", { shown: places.length, total: totalRecords })}
              </span>
              <button
                type="button"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1 || loading || submitting}
              >
                {t("pagination.prev")}
              </button>
              <span>
                {t("pagination.page", { cur: totalPages === 0 ? 0 : currentPage, total: totalPages })}
              </span>
              <button
                type="button"
                onClick={() => goToPage(currentPage + 1)}
                disabled={totalPages === 0 || currentPage >= totalPages || loading || submitting}
              >
                {t("pagination.next")}
              </button>
            </div>
          </>
        )}

        {viewMode === "map" && (
          <>
            <p className="map-view-hint">{t("map.hint")}</p>
            <div className="map-legend">
              <span className="map-legend-title">{t("map.legend")}</span>
              {distinctCollectionKeys.map((key) => {
                const label = key === "" ? t("map.uncategorized") : key;
                const visible = !hiddenMapCollections.includes(key);
                const color =
                  key === "" ? "#94a3b8" : mapCollectionColorByName[key] || "#cbd5e1";
                return (
                  <button
                    key={key === "" ? "__empty__" : key}
                    type="button"
                    className={`map-legend-chip ${visible ? "" : "map-legend-chip-off"}`}
                    onClick={() => toggleMapCollectionVisibility(key)}
                    title={visible ? t("map.legendHide") : t("map.legendShow")}
                  >
                    <span className="map-legend-swatch" style={{ background: color }} aria-hidden />
                    {label}
                  </button>
                );
              })}
            </div>
            <div ref={mapContainerRef} className="map-container map-container-full" />
          </>
        )}

        {viewMode === "collections" && (
          <>
            <div className="panel-title collections-panel-head">
              <div>
                <h2>{t("collections.title")}</h2>
                <p className="collections-intro">{t("collections.intro")}</p>
              </div>
            </div>
            <div className="collections-add-bar">
              <input
                type="text"
                className="collections-add-name"
                placeholder={t("collections.namePh")}
                value={newCollectionName}
                onChange={(e) => setNewCollectionName(e.target.value)}
                disabled={submitting}
              />
              <label className="collections-color-picker-wrap">
                <span className="sr-only">{t("collections.ariaColor")}</span>
                <input
                  type="color"
                  value={normalizeHexColor(newCollectionColor) || "#2563eb"}
                  onChange={(e) => setNewCollectionColor(e.target.value)}
                  disabled={submitting}
                />
              </label>
              <input
                type="text"
                className="collections-hex-input"
                placeholder={t("collections.hexPh")}
                value={newCollectionColor}
                onChange={(e) => setNewCollectionColor(e.target.value)}
                disabled={submitting}
                spellCheck={false}
              />
              <button
                type="button"
                className="btn-primary"
                onClick={handleAddManagedCollection}
                disabled={submitting}
              >
                {t("collections.add")}
              </button>
              <button
                type="button"
                className="collections-sync-btn"
                onClick={syncCollectionsFromPlaces}
                disabled={submitting}
                title={t("collections.syncTitle")}
              >
                {t("collections.sync")}
              </button>
            </div>
            <div className="table-wrap">
              <table className="collections-registry-table">
                <thead>
                  <tr>
                    <th>{t("collections.thName")}</th>
                    <th>{t("collections.thColor")}</th>
                    <th>{t("collections.thActions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {registryDraft.length === 0 && (
                    <tr>
                      <td colSpan={3} className="collections-empty">
                        {t("collections.empty")}
                      </td>
                    </tr>
                  )}
                  {registryDraft.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <input
                          type="text"
                          className="table-inline-input"
                          value={row.name}
                          onChange={(e) => updateCollectionDraft(row.id, { name: e.target.value })}
                          disabled={submitting}
                        />
                      </td>
                      <td>
                        <div className="collections-color-cell">
                          <input
                            type="color"
                            value={normalizeHexColor(row.color) || "#64748b"}
                            onChange={(e) => updateCollectionDraft(row.id, { color: e.target.value })}
                            disabled={submitting}
                            aria-label={t("collections.ariaRowColor")}
                          />
                          <input
                            type="text"
                            className="collections-hex-input"
                            value={row.color}
                            onChange={(e) => updateCollectionDraft(row.id, { color: e.target.value })}
                            disabled={submitting}
                            spellCheck={false}
                          />
                        </div>
                      </td>
                      <td className="actions">
                        <button
                          type="button"
                          onClick={() => saveCollectionRow(row)}
                          disabled={submitting}
                        >
                          {t("form.save")}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setCollDeleteTarget({ id: row.id, name: row.name })
                          }
                          disabled={submitting}
                        >
                          {t("table.delete")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

export default App;
