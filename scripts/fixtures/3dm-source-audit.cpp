// 独立研究工具：输出源网格与实例身份，不生成替代几何。
#include "opennurbs_public.h"
#include <iostream>
#include <sstream>
#include <iomanip>
#include <cmath>
#include <stdexcept>
#include <set>

static std::string quoted(const char* s) {
  std::ostringstream o; o << '"';
  for (const unsigned char* p=(const unsigned char*)s; *p; ++p) {
    if (*p=='"' || *p=='\\') o << '\\' << *p;
    else if (*p<32) o << "\\u" << std::hex << std::setw(4) << std::setfill('0') << (int)*p;
    else o << *p;
  }
  o << '"'; return o.str();
}
static std::string id(ON_UUID u) { char b[40]; ON_UuidToString(u,b); return quoted(b); }
static void number(std::ostream& o, double x) {
  if (!std::isfinite(x)) throw std::runtime_error("nonfinite-coordinate");
  o << std::setprecision(17) << x;
}
static void mesh(std::ostream& o, const ON_Mesh& m) {
  if (!m.IsValid()) throw std::runtime_error("invalid-mesh");
  o << "{\"positions\":[";
  for(int i=0;i<m.VertexCount();++i) {
    if(i) o << ','; auto p=m.Vertex(i); o << '[';
    number(o,p.x); o << ','; number(o,p.y); o << ','; number(o,p.z); o << ']';
  }
  o << "],\"triangles\":["; bool first=true;
  for(int i=0;i<m.m_F.Count();++i) {
    auto f=m.m_F[i];
    for(int j=0;j<4;++j) if(f.vi[j]<0 || f.vi[j]>=m.VertexCount()) throw std::runtime_error("mesh-index-range");
    if(!first) o << ','; first=false;
    o << '[' << f.vi[0] << ',' << f.vi[1] << ',' << f.vi[2] << ']';
    if(f.IsQuad()) o << ",[" << f.vi[0] << ',' << f.vi[2] << ',' << f.vi[3] << ']';
  }
  o << "],\"sourceFaceCount\":" << m.m_F.Count() << ",\"quadCount\":" << m.QuadCount() << '}';
}
static void geometry(std::ostream& o, const ON_ModelGeometryComponent& c) {
  auto a=c.Attributes(nullptr); auto g=c.Geometry(nullptr);
  if(!a || !g) throw std::runtime_error("missing-geometry-or-attributes");
  o << "{\"id\":" << id(c.Id()) << ",\"layerIndex\":" << a->m_layer_index
    << ",\"materialIndex\":" << a->m_material_index << ",\"materialSource\":" << (int)a->MaterialSource()
    << ",\"definitionMember\":" << (c.IsInstanceDefinitionGeometry()?"true":"false");
  if(auto m=ON_Mesh::Cast(g)) { o << ",\"kind\":\"mesh\",\"mesh\":"; mesh(o,*m); }
  else if(auto r=ON_InstanceRef::Cast(g)) {
    o << ",\"kind\":\"instance\",\"definitionId\":" << id(r->m_instance_definition_uuid) << ",\"matrixRowMajor\":[";
    for(int row=0;row<4;++row) for(int col=0;col<4;++col) {
      if(row || col) o << ','; number(o,r->m_xform[row][col]);
    }
    o << ']';
  } else if(auto b=ON_Brep::Cast(g)) {
    o << ",\"kind\":\"brep\",\"faceCount\":" << b->m_F.Count() << ",\"storedRenderMeshes\":[";
    bool first=true;
    for(int i=0;i<b->m_F.Count();++i) if(auto m=b->m_F[i].Mesh(ON::render_mesh)) {
      if(!first) o << ','; first=false;
      o << "{\"face\":" << i << ",\"mesh\":"; mesh(o,*m); o << '}';
    }
    o << ']';
  } else o << ",\"kind\":\"unsupported\",\"objectType\":" << (unsigned)g->ObjectType();
  o << '}';
}
static void dump(const ONX_Model& model, std::ostream& o) {
  o << "{\"schemaVersion\":1,\"archiveVersion\":" << model.m_3dm_file_version
    << ",\"unitSystem\":" << (int)model.m_settings.m_ModelUnitsAndTolerances.m_unit_system.UnitSystem()
    << ",\"metersPerUnit\":";
  number(o,model.m_settings.m_ModelUnitsAndTolerances.m_unit_system.MetersPerUnit(ON_DBL_QNAN));
  o << ",\"objects\":[";
  ONX_ModelComponentIterator it(model,ON_ModelComponent::Type::ModelGeometry);
  bool first=true; std::set<std::string> ids;
  for(auto c=it.FirstComponent();c;c=it.NextComponent()) {
    auto g=ON_ModelGeometryComponent::Cast(c);
    if(!g || !ids.insert(id(c->Id())).second) throw std::runtime_error("invalid-object-id");
    if(!first) o << ','; first=false; geometry(o,*g);
  }
  o << "],\"definitions\":[";
  ONX_ModelComponentIterator di(model,ON_ModelComponent::Type::InstanceDefinition); first=true;
  for(auto c=di.FirstComponent();c;c=di.NextComponent()) {
    auto d=ON_InstanceDefinition::Cast(c); if(!d) throw std::runtime_error("invalid-definition");
    if(!first) o << ','; first=false;
    o << "{\"id\":" << id(c->Id()) << ",\"members\":[";
    const auto& members=d->InstanceGeometryIdList();
    for(int i=0;i<members.Count();++i) {
      if(!ids.count(id(members[i]))) throw std::runtime_error("missing-definition-member");
      if(i) o << ','; o << id(members[i]);
    }
    o << "]}";
  }
  o << "],\"layers\":[";
  ONX_ModelComponentIterator li(model,ON_ModelComponent::Type::Layer); first=true;
  for(auto c=li.FirstComponent();c;c=li.NextComponent()) {
    auto l=ON_Layer::Cast(c); if(!l) throw std::runtime_error("invalid-layer");
    if(!first) o << ','; first=false;
    ON_String name(l->Name());
    o << "{\"id\":" << id(l->Id()) << ",\"index\":" << l->Index() << ",\"name\":" << quoted(name.Array())
      << ",\"parentId\":" << id(l->ParentId()) << ",\"materialIndex\":" << l->RenderMaterialIndex() << '}';
  }
  o << "],\"materials\":[";
  ONX_ModelComponentIterator mi(model,ON_ModelComponent::Type::RenderMaterial); first=true;
  for(auto c=mi.FirstComponent();c;c=mi.NextComponent()) {
    auto m=ON_Material::Cast(c); if(!m) throw std::runtime_error("invalid-material");
    if(!first) o << ','; first=false; ON_String name(m->Name());
    o << "{\"id\":" << id(m->Id()) << ",\"index\":" << m->Index() << ",\"name\":" << quoted(name.Array()) << '}';
  }
  o << "]}\n";
}
int wmain(int argc,wchar_t** argv) {
  if(argc!=2) return 2;
  ON::Begin(); int result=0;
  try {
    ONX_Model model; ON_TextLog errors(stderr);
    if(!model.Read(argv[1],&errors)) throw std::runtime_error("read-failed");
    // 完整缓冲，错误时不留下看似成功的部分 JSON。
    std::ostringstream out; dump(model,out); std::cout << out.str();
  } catch(const std::exception& e) { std::cerr << e.what() << '\n'; result=1; }
  ON::End(); return result;
}
