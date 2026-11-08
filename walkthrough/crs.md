# Projected data and PNG export

- A shapefile uses the `.prj` file next to it, so data in a projected system (UTM, State Plane, Lambert, Albers) lands in the right place.
- GeoJSON with a `crs` member (for example EPSG:3857) is reprojected too.
- For other data, type an EPSG code (`27700`, `EPSG:32633`), a proj4 string or a WKT in Coordinate system and press Apply.
- Export PNG saves the current map view as an image.
- Settings: largest file to open, the offline basemap, and live preview while you edit.
