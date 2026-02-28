const admin = require('firebase-admin');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');

function getServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON_FILE) {
    try {
      const absolutePath = path.resolve(process.cwd(), process.env.FIREBASE_SERVICE_ACCOUNT_JSON_FILE);
      const fileContent = fs.readFileSync(absolutePath, 'utf8');
      const parsed = JSON.parse(fileContent);
      if (parsed.private_key) {
        parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
      }
      return parsed;
    } catch {
      throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON_FILE. It must point to a valid JSON file.');
    }
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
      if (parsed.private_key) {
        parsed.private_key = String(parsed.private_key).replace(/\\n/g, '\n');
      }
      return parsed;
    } catch {
      throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_JSON. It must be valid JSON.');
    }
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (projectId && clientEmail && privateKey) {
    return {
      project_id: projectId,
      client_email: clientEmail,
      private_key: String(privateKey).replace(/\\n/g, '\n')
    };
  }

  return null;
}

function initFirebase() {
  if (admin.apps.length) return admin.firestore();

  const serviceAccount = getServiceAccount();
  if (serviceAccount) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  } else {
    throw new Error(
      'Firebase credentials missing. Set FIREBASE_SERVICE_ACCOUNT_JSON_FILE, FIREBASE_SERVICE_ACCOUNT_JSON, or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.'
    );
  }

  return admin.firestore();
}

const db = initFirebase();

function now() {
  return new Date().toISOString();
}

function docToObject(doc) {
  if (!doc.exists) return null;
  return { id: Number(doc.id), ...doc.data() };
}

async function nextId(key) {
  const ref = db.collection('counters').doc(key);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? Number(snap.data().value || 1) : 1;
    tx.set(ref, { value: current + 1 }, { merge: true });
    return current;
  });
}

async function ensureCounterDocs() {
  const keys = ['users', 'products', 'orders'];
  await Promise.all(
    keys.map(async (key) => {
      const ref = db.collection('counters').doc(key);
      const snap = await ref.get();
      if (!snap.exists) {
        await ref.set({ value: 1 });
      }
    })
  );
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim();
}

async function initDb() {
  await ensureCounterDocs();

  const adminEmail = 'admin@phonestore.com';
  const adminQuery = await db.collection('users').where('email', '==', adminEmail).limit(1).get();
  if (adminQuery.empty) {
    const id = await nextId('users');
    await db.collection('users').doc(String(id)).set({
      name: 'Store Admin',
      email: adminEmail,
      password_hash: bcrypt.hashSync('admin123', 10),
      is_admin: 1,
      created_at: now()
    });
  }

  const productAny = await db.collection('products').limit(1).get();
  if (!productAny.empty) return;

  const seedProducts = [
    ['iPhone 16 Pro', 'Latest Apple flagship with advanced camera system.', 1299, 'https://images.unsplash.com/photo-1592750475338-74b7b21085ab?w=1000', 15, 'Phone'],
    ['Samsung Galaxy S26', 'Premium Android phone with dynamic AMOLED display.', 1199, 'https://images.unsplash.com/photo-1610945415295-d9bbf067e59c?w=1000', 20, 'Phone'],
    ['Google Pixel 11', 'Pure Android experience with top AI camera features.', 999, 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=1000', 12, 'Phone'],
    ['65W Fast Charger', 'Universal USB-C fast charger for phones and tablets.', 39, 'https://images.unsplash.com/photo-1583863788434-e58a36330cf0?w=1000', 100, 'Accessory'],
    ['Wireless Earbuds Pro', 'Noise-cancelling earbuds with long battery life.', 149, 'https://images.unsplash.com/photo-1590658268037-6bf12165a8df?w=1000', 45, 'Accessory'],
    ['MagSafe Power Bank', 'Portable magnetic power bank for modern smartphones.', 79, 'https://images.unsplash.com/photo-1609592424708-0d3cb52b62b4?w=1000', 30, 'Accessory']
  ];

  for (const p of seedProducts) {
    const id = await nextId('products');
    await db.collection('products').doc(String(id)).set({
      name: p[0],
      description: p[1],
      price: p[2],
      image_url: p[3],
      stock: p[4],
      category: p[5],
      created_at: now()
    });
  }
}

async function findUserByEmail(email) {
  const query = await db.collection('users').where('email', '==', email).limit(1).get();
  if (query.empty) return null;
  return docToObject(query.docs[0]);
}

async function createUser(name, email, passwordHash) {
  const id = await nextId('users');
  const user = {
    name,
    email,
    password_hash: passwordHash,
    is_admin: 0,
    created_at: now()
  };
  await db.collection('users').doc(String(id)).set(user);
  return { id, ...user };
}

async function getFeaturedProducts(limit = 6) {
  const snap = await db.collection('products').orderBy('created_at', 'desc').limit(limit).get();
  return snap.docs.map((d) => docToObject(d));
}

async function listProducts({ category, q }) {
  let ref = db.collection('products');

  if (category) {
    ref = ref.where('category', '==', category);
  }

  const snap = await ref.get();
  let products = snap.docs.map((d) => docToObject(d));

  if (q) {
    const key = normalizeText(q);
    const tokens = key.split(/\s+/).filter(Boolean);

    products = products
      .map((p) => {
        const nameNorm = normalizeText(p.name);
        const descNorm = normalizeText(p.description);
        let score = 0;

        if (nameNorm === key) score += 100;
        if (nameNorm.startsWith(key)) score += 60;
        if (nameNorm.includes(key)) score += 40;
        if (tokens.length && tokens.every((t) => nameNorm.includes(t))) score += 30;
        if (descNorm.includes(key)) score += 10;
        if (tokens.length && tokens.every((t) => descNorm.includes(t))) score += 5;

        return { product: p, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || new Date(b.product.created_at) - new Date(a.product.created_at))
      .map((x) => x.product);

    return products;
  }

  return products.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function getProductById(id) {
  const snap = await db.collection('products').doc(String(Number(id))).get();
  return docToObject(snap);
}

async function createProduct(payload) {
  const id = await nextId('products');
  const product = { created_at: now(), ...payload };
  await db.collection('products').doc(String(id)).set(product);
  return { id, ...product };
}

async function updateProduct(id, payload) {
  const ref = db.collection('products').doc(String(Number(id)));
  const snap = await ref.get();
  if (!snap.exists) return null;
  await ref.set(payload, { merge: true });
  const updated = await ref.get();
  return docToObject(updated);
}

async function deleteProduct(id) {
  const productId = Number(id);
  await db.collection('products').doc(String(productId)).delete();

  const cartSnap = await db.collection('cart_items').where('product_id', '==', productId).get();
  const deletions = cartSnap.docs.map((doc) => doc.ref.delete());
  await Promise.all(deletions);
}

async function getCartCount(userId) {
  const snap = await db.collection('cart_items').where('user_id', '==', Number(userId)).get();
  return snap.docs.reduce((sum, d) => sum + Number(d.data().quantity || 0), 0);
}

async function getCartItems(userId) {
  const cartSnap = await db.collection('cart_items').where('user_id', '==', Number(userId)).get();
  if (cartSnap.empty) return [];

  const items = await Promise.all(
    cartSnap.docs.map(async (doc) => {
      const c = doc.data();
      const pDoc = await db.collection('products').doc(String(c.product_id)).get();
      if (!pDoc.exists) return null;
      const p = pDoc.data();
      return {
        product_id: c.product_id,
        quantity: c.quantity,
        name: p.name,
        price: p.price,
        image_url: p.image_url,
        stock: p.stock
      };
    })
  );

  return items.filter(Boolean);
}

async function addToCart(userId, productId, quantity) {
  const uId = Number(userId);
  const pId = Number(productId);
  const cartRef = db.collection('cart_items').doc(`${uId}_${pId}`);
  const productRef = db.collection('products').doc(String(pId));

  return db.runTransaction(async (tx) => {
    const productSnap = await tx.get(productRef);
    if (!productSnap.exists) return { ok: false, error: 'Product not found.' };

    const product = productSnap.data();
    if (product.stock < quantity) return { ok: false, error: 'Not enough stock available.' };

    const cartSnap = await tx.get(cartRef);
    const current = cartSnap.exists ? Number(cartSnap.data().quantity || 0) : 0;
    const newQty = Math.min(current + quantity, Number(product.stock));

    tx.set(
      cartRef,
      {
        user_id: uId,
        product_id: pId,
        quantity: newQty
      },
      { merge: true }
    );

    return { ok: true };
  });
}

async function updateCartItem(userId, productId, quantity) {
  const uId = Number(userId);
  const pId = Number(productId);
  const cartRef = db.collection('cart_items').doc(`${uId}_${pId}`);

  if (quantity <= 0) {
    await cartRef.delete();
    return { ok: true, removed: true };
  }

  const productSnap = await db.collection('products').doc(String(pId)).get();
  if (!productSnap.exists) return { ok: false, error: 'Product not found.' };

  const product = productSnap.data();
  await cartRef.set(
    {
      user_id: uId,
      product_id: pId,
      quantity: Math.min(Number(quantity), Number(product.stock))
    },
    { merge: true }
  );

  return { ok: true };
}

async function removeCartItem(userId, productId) {
  const uId = Number(userId);
  const pId = Number(productId);
  await db.collection('cart_items').doc(`${uId}_${pId}`).delete();
}

async function createOrder(userId, shipping) {
  const uId = Number(userId);
  const cartSnap = await db.collection('cart_items').where('user_id', '==', uId).get();
  if (cartSnap.empty) return { ok: false, error: 'Your cart is empty.' };

  const orderId = await nextId('orders');
  const orderRef = db.collection('orders').doc(String(orderId));

  try {
    await db.runTransaction(async (tx) => {
      const items = [];
      const cartDocs = cartSnap.docs;

      for (const cDoc of cartDocs) {
        const c = cDoc.data();
        const pRef = db.collection('products').doc(String(c.product_id));
        const pSnap = await tx.get(pRef);

        if (!pSnap.exists) {
          throw new Error('Product not found in cart.');
        }

        const p = pSnap.data();
        if (Number(c.quantity) > Number(p.stock)) {
          throw new Error(`Insufficient stock for ${p.name}.`);
        }

        items.push({
          product_id: c.product_id,
          name: p.name,
          quantity: c.quantity,
          price_at_purchase: p.price
        });
      }

      const total = items.reduce((sum, i) => sum + Number(i.price_at_purchase) * Number(i.quantity), 0);

      tx.set(orderRef, {
        user_id: uId,
        total_amount: total,
        status: 'Pending',
        shipping_name: shipping.shipping_name,
        shipping_phone: shipping.shipping_phone,
        shipping_address: shipping.shipping_address,
        created_at: now(),
        items
      });

      for (const cDoc of cartDocs) {
        const c = cDoc.data();
        const pRef = db.collection('products').doc(String(c.product_id));
        const pSnap = await tx.get(pRef);
        const p = pSnap.data();

        tx.update(pRef, { stock: Number(p.stock) - Number(c.quantity) });
        tx.delete(cDoc.ref);
      }
    });
  } catch (error) {
    return { ok: false, error: error.message || 'Order failed.' };
  }

  const orderSnap = await orderRef.get();
  return { ok: true, order: docToObject(orderSnap) };
}

async function listOrdersByUser(userId) {
  const snap = await db.collection('orders').where('user_id', '==', Number(userId)).get();
  return snap.docs
    .map((d) => docToObject(d))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

module.exports = {
  initDb,
  findUserByEmail,
  createUser,
  getFeaturedProducts,
  listProducts,
  getProductById,
  createProduct,
  updateProduct,
  deleteProduct,
  getCartCount,
  getCartItems,
  addToCart,
  updateCartItem,
  removeCartItem,
  createOrder,
  listOrdersByUser
};
