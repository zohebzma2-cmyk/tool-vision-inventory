import { useState } from "react";
import { Plus, Package, MapPin, BarChart3, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AddItemDialog } from "@/components/inventory/AddItemDialog";
import { ItemsList } from "@/components/inventory/ItemsList";
import { LocationsList } from "@/components/inventory/LocationsList";
import { QRScanner } from "@/components/inventory/QRScanner";

const Index = () => {
  const [showAddItem, setShowAddItem] = useState(false);
  const [showQRScanner, setShowQRScanner] = useState(false);

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <Package className="h-8 w-8 text-primary" />
              <h1 className="text-2xl font-bold text-foreground">Tool Inventory</h1>
            </div>
            <div className="flex space-x-2">
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => setShowQRScanner(true)}
              >
                <Search className="h-4 w-4 mr-2" />
                Scan QR
              </Button>
              <Button 
                size="sm"
                onClick={() => setShowAddItem(true)}
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Item
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total Items</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Locations</CardTitle>
              <MapPin className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Categories</CardTitle>
              <BarChart3 className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">0</div>
            </CardContent>
          </Card>
          
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Low Stock</CardTitle>
              <Package className="h-4 w-4 text-destructive" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-destructive">0</div>
            </CardContent>
          </Card>
        </div>

        <Tabs defaultValue="items" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="items">Items</TabsTrigger>
            <TabsTrigger value="locations">Locations</TabsTrigger>
            <TabsTrigger value="analytics">Analytics</TabsTrigger>
          </TabsList>
          
          <TabsContent value="items">
            <ItemsList />
          </TabsContent>
          
          <TabsContent value="locations">
            <LocationsList />
          </TabsContent>
          
          <TabsContent value="analytics">
            <Card>
              <CardHeader>
                <CardTitle>Analytics</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">Usage analytics and reports will appear here.</p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>

      <AddItemDialog 
        open={showAddItem} 
        onOpenChange={setShowAddItem} 
      />
      
      <QRScanner 
        open={showQRScanner} 
        onOpenChange={setShowQRScanner} 
      />
    </div>
  );
};

export default Index;
