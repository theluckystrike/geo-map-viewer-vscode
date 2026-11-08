# Changelog

## 0.1.0 (2026-11-08)

First release.

- Map viewer for GeoJSON, TopoJSON, KML, KMZ, GPX, shapefiles (also zipped), WKT, and CSV or TSV with latitude and longitude columns.
- Offline basemap (Natural Earth 1:50m countries and lakes) inside the extension. No network requests.
- Feature properties on click, attribute table with a filter, layers for KML folders, TopoJSON objects and GPX parts.
- GPX distance, duration, moving time, elevation gain and loss, and an elevation profile.
- Reprojection from `.prj` files, the GeoJSON `crs` member and EPSG codes, proj4 strings or WKT typed in the panel.
- SimpleStyle and KML styles. PNG export. Live preview while you edit a GeoJSON, KML, GPX, WKT or CSV file.
- Large files parsed and drawn in a web worker. Guards against zip bombs, XML entity bombs and broken coordinates.
- Files are read through VS Code, so Remote SSH, WSL, Dev Containers and Codespaces work.
- "More free viewers" starts with the Zovo extensions most related to this one. Picking one opens its Marketplace page, where you choose to install it.
- The README has a "Support Zovo" section with GitHub Sponsors and the developer's GitHub profile, and "More tools by Zovo" lists related extensions.
