import React, { useEffect, useMemo, useState } from "react";
import maplibregl from "maplibre-gl";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const DEFAULT_MAP_STYLE =
  "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

const MAP_STYLE_OPTIONS = [
  {
    id: "light",
    label: "White",
    url: DEFAULT_MAP_STYLE
  },
  {
    id: "dark",
    label: "Dark",
    url: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
  }
];

function extractPointCoordinates(list) {
  return list
    .map((place) => place?.geometry?.coordinates)
    .filter(
      (coords) =>
        Array.isArray(coords) &&
        coords.length >= 2 &&
        !Number.isNaN(Number(coords[0])) &&
        !Number.isNaN(Number(coords[1]))
    )
    .map((coords) => [Number(coords[0]), Number(coords[1])]);
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

function App() {
  const [places, setPlaces] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [viewMode, setViewMode] = useState("table");
  const [selectedPlaceId, setSelectedPlaceId] = useState("");
  const [mapStyleUrl, setMapStyleUrl] = useState(DEFAULT_MAP_STYLE);
  const [form, setForm] = useState({
    name: "",
    lng: "",
    lat: ""
  });
  const [editingId, setEditingId] = useState("");
  const [pickedPointLabel, setPickedPointLabel] = useState("");
  const mapContainerRef = React.useRef(null);
  const mapRef = React.useRef(null);
  const markersRef = React.useRef([]);
  const markerByIdRef = React.useRef({});
  const draftMarkerRef = React.useRef(null);
  const clickPopupRef = React.useRef(null);

  const apiUrl = useMemo(
    () => (API_BASE_URL ? `${API_BASE_URL}/api/places` : ""),
    []
  );

  async function loadPlaces() {
    setLoading(true);
    setError("");
    if (!apiUrl) {
      setLoading(false);
      setError("Missing VITE_API_BASE_URL");
      return;
    }
    try {
      const response = await fetch(apiUrl);
      if (!response.ok) {
        throw new Error(`API error: ${response.status}`);
      }
      const json = await response.json();
      setPlaces(Array.isArray(json.data) ? json.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function submitPlace(event) {
    event.preventDefault();
    if (!apiUrl) {
      setError("Missing VITE_API_BASE_URL");
      return;
    }
    const lng = Number(form.lng);
    const lat = Number(form.lat);
    if (!form.name.trim() || Number.isNaN(lng) || Number.isNaN(lat)) {
      setError("Please provide name, longitude, and latitude");
      return;
    }

    setSubmitting(true);
    setError("");
    try {
      const method = editingId ? "PATCH" : "POST";
      const url = editingId ? `${apiUrl}/${editingId}` : apiUrl;
      const body = editingId
        ? {
            properties: { name: form.name.trim() },
            geometry: { type: "Point", coordinates: [lng, lat] }
          }
        : {
            type: "Feature",
            geometry: { type: "Point", coordinates: [lng, lat] },
            properties: { name: form.name.trim() }
          };

      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        throw new Error(`Save failed: ${response.status}`);
      }
      setForm({ name: "", lng: "", lat: "" });
      setEditingId("");
      setPickedPointLabel("");
      if (draftMarkerRef.current) {
        draftMarkerRef.current.remove();
        draftMarkerRef.current = null;
      }
      if (clickPopupRef.current) {
        clickPopupRef.current.remove();
        clickPopupRef.current = null;
      }
      await loadPlaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(place) {
    setEditingId(place.id);
    setForm({
      name: place?.properties?.name || "",
      lng: String(place?.geometry?.coordinates?.[0] ?? ""),
      lat: String(place?.geometry?.coordinates?.[1] ?? "")
    });
  }

  function cancelEdit() {
    setEditingId("");
    setForm({ name: "", lng: "", lat: "" });
    setPickedPointLabel("");
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
      setError("Missing VITE_API_BASE_URL");
      return;
    }
    const ok = window.confirm("Delete this place?");
    if (!ok) return;
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
      await loadPlaces();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  function showOnMap(place) {
    if (!place?.id) return;
    setSelectedPlaceId(place.id);
    setViewMode("map");
  }

  useEffect(() => {
    loadPlaces();
  }, [apiUrl]);

  useEffect(() => {
    if (viewMode !== "map") return;
    if (!mapContainerRef.current) return;
    if (mapRef.current) return;

    const points = extractPointCoordinates(places);
    const initialCenter = points.length > 0 ? points[0] : [100.5018, 13.7563];
    const initialZoom = points.length > 0 ? 10 : 5;

    mapRef.current = new maplibregl.Map({
      container: mapContainerRef.current,
      style: mapStyleUrl,
      center: initialCenter,
      zoom: initialZoom
    });

    mapRef.current.addControl(new maplibregl.NavigationControl(), "top-right");

    const handleMapClick = (event) => {
      const lng = Number(event.lngLat.lng.toFixed(6));
      const lat = Number(event.lngLat.lat.toFixed(6));

      let nearest = null;
      places.forEach((place) => {
        const coords = place?.geometry?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) return;
        const pLng = Number(coords[0]);
        const pLat = Number(coords[1]);
        if (Number.isNaN(pLng) || Number.isNaN(pLat)) return;
        const meters = distanceMeters(lat, lng, pLat, pLng);
        if (!nearest || meters < nearest.meters) {
          nearest = {
            name: place?.properties?.name || "Unnamed place",
            meters
          };
        }
      });

      const isExactExistingPoint = nearest && nearest.meters <= 8;
      if (clickPopupRef.current) {
        clickPopupRef.current.remove();
      }

      if (isExactExistingPoint) {
        setPickedPointLabel("");
        if (draftMarkerRef.current) {
          draftMarkerRef.current.remove();
          draftMarkerRef.current = null;
        }
        return;
      }

      setForm((prev) => ({
        ...prev,
        lng: String(lng),
        lat: String(lat)
      }));
      setPickedPointLabel(`${lng}, ${lat}`);

      if (draftMarkerRef.current) {
        draftMarkerRef.current.remove();
      }
      const draftEl = document.createElement("div");
      draftEl.className = "map-marker map-marker-draft";
      draftMarkerRef.current = new maplibregl.Marker({ element: draftEl })
        .setLngLat([lng, lat])
        .addTo(mapRef.current);

      clickPopupRef.current = new maplibregl.Popup({ offset: 20 })
        .setLngLat([lng, lat])
        .setHTML(`<div><strong>Picked point</strong><br/>lat: ${lat}<br/>lon: ${lng}</div>`)
        .addTo(mapRef.current);
    };

    mapRef.current.on("click", handleMapClick);

    return () => {
      if (mapRef.current) {
        mapRef.current.off("click", handleMapClick);
      }
      markersRef.current.forEach((marker) => marker.remove());
      markersRef.current = [];
      if (draftMarkerRef.current) {
        draftMarkerRef.current.remove();
        draftMarkerRef.current = null;
      }
      if (clickPopupRef.current) {
        clickPopupRef.current.remove();
        clickPopupRef.current = null;
      }
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [viewMode]);

  useEffect(() => {
    if (!mapRef.current) return;
    if (!mapStyleUrl) return;
    mapRef.current.setStyle(mapStyleUrl);
  }, [mapStyleUrl]);

  useEffect(() => {
    if (!mapRef.current) return;

    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];
    markerByIdRef.current = {};

    const bounds = new maplibregl.LngLatBounds();
    let pointCount = 0;

    places.forEach((place) => {
      const coords = place?.geometry?.coordinates;
      const name = place?.properties?.name || "Unnamed place";
      if (!Array.isArray(coords) || coords.length < 2) return;
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      if (Number.isNaN(lng) || Number.isNaN(lat)) return;

      const markerEl = document.createElement("button");
      markerEl.type = "button";
      markerEl.className = "map-marker";
      markerEl.setAttribute("aria-label", name);

      const marker = new maplibregl.Marker({ element: markerEl })
        .setLngLat([lng, lat])
        .setPopup(
          new maplibregl.Popup({ offset: 24 }).setHTML(
            `<div><strong>${name}</strong><br/>lat: ${lat}<br/>lon: ${lng}</div>`
          )
        )
        .addTo(mapRef.current);

      markersRef.current.push(marker);
      markerByIdRef.current[place.id] = marker;
      bounds.extend([lng, lat]);
      pointCount += 1;
    });

    if (pointCount > 1) {
      mapRef.current.fitBounds(bounds, { padding: 60, maxZoom: 12 });
    } else if (pointCount === 1) {
      const center = bounds.getCenter();
      mapRef.current.flyTo({ center, zoom: 12 });
    }
  }, [mapStyleUrl, places, viewMode]);

  useEffect(() => {
    if (viewMode !== "map") return;
    if (!selectedPlaceId) return;
    if (!mapRef.current) return;

    const target = places.find((place) => place.id === selectedPlaceId);
    const coords = target?.geometry?.coordinates;
    if (!target || !Array.isArray(coords) || coords.length < 2) return;

    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (Number.isNaN(lng) || Number.isNaN(lat)) return;

    mapRef.current.flyTo({ center: [lng, lat], zoom: 13 });
    const marker = markerByIdRef.current[selectedPlaceId];
    if (marker) {
      marker.togglePopup();
    }
  }, [places, selectedPlaceId, viewMode]);

  return (
    <main className="page">
      <header className="header">
        <h1>Mini Spatial Data</h1>
        <p>Places list from backend API</p>
      </header>

      <section className="panel">
        <div className="panel-title">
          <h2>Places</h2>
          <span className="count">{places.length} records</span>
        </div>
        <div className="view-switch">
          <button
            type="button"
            className={viewMode === "table" ? "active" : ""}
            onClick={() => setViewMode("table")}
          >
            Table
          </button>
          <button
            type="button"
            className={viewMode === "map" ? "active" : ""}
            onClick={() => setViewMode("map")}
          >
            Map
          </button>
        </div>

        {loading && <p>Loading...</p>}
        {error && <p className="error">Error: {error}</p>}
        <form className="place-form" onSubmit={submitPlace}>
          <input
            type="text"
            placeholder="Place name"
            value={form.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
          />
          <input
            type="number"
            step="any"
            placeholder="Longitude"
            value={form.lng}
            onChange={(e) => setForm((prev) => ({ ...prev, lng: e.target.value }))}
          />
          <input
            type="number"
            step="any"
            placeholder="Latitude"
            value={form.lat}
            onChange={(e) => setForm((prev) => ({ ...prev, lat: e.target.value }))}
          />
          <button type="submit" disabled={submitting}>
            {editingId ? "Update" : "Add"}
          </button>
          {editingId && (
            <button type="button" onClick={cancelEdit} disabled={submitting}>
              Cancel
            </button>
          )}
        </form>
        <p className="map-help">
          Tip: click on the map to auto-fill coordinates.
          {pickedPointLabel && ` Picked: ${pickedPointLabel}.`}
        </p>

        {viewMode === "table" && (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Longitude</th>
                <th>Latitude</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {places.length === 0 && (
                <tr>
                  <td colSpan={4}>No places found</td>
                </tr>
              )}
              {places.map((place) => (
                <tr key={place.id}>
                  <td>{place?.properties?.name || "-"}</td>
                  <td>{place?.geometry?.coordinates?.[0] ?? "-"}</td>
                  <td>{place?.geometry?.coordinates?.[1] ?? "-"}</td>
                  <td className="actions">
                    <button
                      type="button"
                      onClick={() => showOnMap(place)}
                      disabled={submitting}
                    >
                      Show on map
                    </button>
                    <button
                      type="button"
                      onClick={() => startEdit(place)}
                      disabled={submitting}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => deletePlace(place.id)}
                      disabled={submitting}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {viewMode === "map" && (
          <>
            <div className="map-meta">
              <span>Interactive map view</span>
              <span>{places.length} point(s)</span>
            </div>
            <label className="map-style-row">
              <span>Map style:</span>
              <select
                value={mapStyleUrl}
                onChange={(e) => setMapStyleUrl(e.target.value)}
              >
                {MAP_STYLE_OPTIONS.map((opt) => (
                  <option key={opt.id} value={opt.url}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
            <div ref={mapContainerRef} className="map-container" />
          </>
        )}
      </section>
    </main>
  );
}

export default App;
