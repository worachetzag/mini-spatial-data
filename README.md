# mini-spatial-data

แอปตัวอย่างจัดการข้อมูลเชิงพื้นที่ (GeoJSON): backend **Go + Echo + MongoDB**, frontend **React + Vite + MapLibre** — รองรับ Point / LineString / Polygon, คอลเลกชัน (สีบนแผนที่), import/export CSV & XLSX

## ความต้องการของระบบ

- **Go** 1.24+ (สำหรับรัน backend แบบ native)
- **Node.js** 18+ และ npm (สำหรับ frontend)
- **MongoDB** 7+ (หรือใช้ MongoDB จาก Docker Compose ใน repo นี้)

## Environment variables

### Backend

| ตัวแปร | จำเป็น? | ค่าเริ่มต้น | คำอธิบาย |
|--------|---------|-------------|-----------|
| `MONGODB_URI` | ไม่ | `mongodb://localhost:27017` | URI ของ MongoDB |
| `MONGODB_DB` | ไม่ | `spatial_data` | ชื่อฐานข้อมูล |
| `PORT` | ไม่ | `8080` | พอร์ต HTTP ของ API |
| `CORS_ALLOW_ORIGINS` | ไม่ | `*` | ต้นทางที่อนุญาต CORS คั่นด้วย comma (เช่น `http://localhost:5173,http://127.0.0.1:5173`) |

### Frontend

| ตัวแปร | จำเป็น? | คำอธิบาย |
|--------|---------|-----------|
| `VITE_API_BASE_URL` | **ใช่** (ตอน build / dev) | URL ของ backend แบบไม่มี trailing slash เช่น `http://localhost:8080` |

คัดลอกจากตัวอย่าง:

```bash
cp frontend/.env.example frontend/.env
```

แก้ `VITE_API_BASE_URL` ให้ตรงกับที่ backend รันอยู่

## ติดตั้งและรัน Backend

จากโฟลเดอร์โปรเจกต์:

```bash
cd backend
go mod download
```

ให้ MongoDB ทำงานอยู่ แล้ว:

```bash
# จากโฟลเดอร์ backend (ใช้ค่า default URI / DB ได้ถ้า MongoDB อยู่ที่ localhost:27017)
go run .

# หรือ build แล้วรัน
go build -o mini-spatial-api .
./mini-spatial-api
```

API จะฟังที่พอร์ต **8080** (หรือตาม `PORT`)

## ติดตั้งและรัน Frontend

```bash
cd frontend
npm install
npm run dev
```

Dev server ปกติอยู่ที่ **http://localhost:5173** — ต้องมี `frontend/.env` ชี้ `VITE_API_BASE_URL` ไปที่ backend

Production build:

```bash
cd frontend
npm run build
npm run preview   # ทดสอบไฟล์ใน dist/
```

## รันทั้งสแต็กด้วย Docker Compose

```bash
docker compose up --build
```

- MongoDB: พอร์ต **27017**
- Backend: **http://localhost:8080**
- Frontend: **http://localhost:5173** (ใน compose ตั้ง `VITE_API_BASE_URL=http://localhost:8080` ให้เบราว์เซอร์เรียก API ที่เครื่อง host)

## Postman

นำเข้า collection: [`postman/mini-spatial-data.postman_collection.json`](postman/mini-spatial-data.postman_collection.json)

ตัวแปร collection:

- `baseUrl` — ปกติ `http://localhost:8080`
- `placeId` — ตั้งอัตโนมัติหลัง **Create Place** (test script)
- `collectionId` — ตั้งอัตโนมัติหลัง **Create Collection**

คำขอ **Import Places** ใช้ form field ชื่อ `file` (เลือกไฟล์ CSV หรือ XLSX ใน Postman)
