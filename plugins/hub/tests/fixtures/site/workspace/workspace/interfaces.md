# Interfaces

The web client calls the service over HTTP.

```mermaid
sequenceDiagram
  participant Web
  participant Service
  Web->>Service: GET /items
  Service-->>Web: 200
```
