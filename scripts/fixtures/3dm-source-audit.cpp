// 独立研究工具：输出源网格与实例身份，不生成替代几何。
#include "opennurbs_public.h"
#include <iostream>
#include <sstream>
#include <iomanip>
#include <cmath>
#include <stdexcept>
#include <set>

static std::string quoted(const char* s) {
  if(!s) return "\"\"";
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
static void meshAttributes(std::ostream& o, const ON_Mesh& m) {
  if(m.m_N.Count() && m.m_N.Count()!=m.VertexCount()) throw std::runtime_error("normal-count-mismatch");
  if(m.m_T.Count() && m.m_T.Count()!=m.VertexCount()) throw std::runtime_error("uv-count-mismatch");
  o << ",\"normals\":[";
  for(int i=0;i<m.m_N.Count();++i) {
    if(i) o << ','; auto n=m.m_N[i]; o << '[';
    number(o,n.x); o << ','; number(o,n.y); o << ','; number(o,n.z); o << ']';
  }
  o << "],\"textureCoordinates\":[";
  // m_T 是已保存的每顶点纹理坐标；m_S 也可能是曲面参数，不能直接冒充 UV。
  for(int i=0;i<m.m_T.Count();++i) {
    if(i) o << ','; auto uv=m.m_T[i]; o << '[';
    number(o,uv.x); o << ','; number(o,uv.y); o << ']';
  }
  o << "],\"textureCoordinateSource\":\"ON_Mesh.m_T\",\"surfaceParameterCount\":" << m.m_S.Count();
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
  o << "],\"sourceFaceCount\":" << m.m_F.Count() << ",\"quadCount\":" << m.QuadCount();
  meshAttributes(o,m); o << '}';
}
static void interval(std::ostream& o, const ON_Interval& d) {
  if(!d.IsIncreasing()) throw std::runtime_error("invalid-domain");
  o << '['; number(o,d.Min()); o << ','; number(o,d.Max()); o << ']';
}
static void tolerance(std::ostream& o, double value) {
  if(std::isfinite(value) && value>=0.0) number(o,value); else o << "null";
}
#include "3dm-parameter-map.h"
static void nurbsCurve(std::ostream& o, const ON_Curve& source) {
  ON_NurbsCurve n;
  const int accuracy=source.GetNurbForm(n);
  if(accuracy<=0 || !n.IsValid() || n.m_dim<2 || n.m_dim>3 || n.m_order<2 || n.m_cv_count<n.m_order)
    throw std::runtime_error("unsupported-brep-curve");
  o << "{\"dimension\":" << n.m_dim << ",\"degree\":" << n.Degree()
    << ",\"rational\":" << (n.m_is_rat?"true":"false") << ",\"parameterization\":" << accuracy
    << ",\"closed\":" << (source.IsClosed()?"true":"false") << ",\"periodic\":" << (source.IsPeriodic()?"true":"false")
    << ",\"controlPointEncoding\":\"" << (n.m_is_rat?"homogeneous":"euclidean")
    << "\",\"knotConvention\":\"full-openNURBS-end-duplicated\",\"domain\":"; interval(o,source.Domain());
  o << ",\"knots\":[";
  const int knot_count=n.m_order+n.m_cv_count-2;
  number(o,n.m_knot[0]);
  for(int i=0;i<knot_count;++i) { o << ','; number(o,n.m_knot[i]); }
  o << ','; number(o,n.m_knot[knot_count-1]);
  o << "],\"controlPoints\":[";
  for(int i=0;i<n.m_cv_count;++i) {
    if(i) o << ','; const double* cv=n.CV(i); o << '[';
    for(int j=0;j<n.CVSize();++j) { if(j) o << ','; number(o,cv[j]); }
    o << ']';
  }
  o << "],\"parameterMap\":"; curveParameterMap(o,source,accuracy);
  if(accuracy==2) { o << ",\"parameterEvidence\":"; curveParameterEvidence(o,source); }
  o << '}';
}
static void nurbsSurface(std::ostream& o, const ON_Surface& source) {
  ON_NurbsSurface n;
  const int accuracy=source.GetNurbForm(n);
  if(accuracy<=0 || !n.IsValid() || n.m_dim!=3 || n.m_order[0]<2 || n.m_order[1]<2
    || n.m_cv_count[0]<n.m_order[0] || n.m_cv_count[1]<n.m_order[1])
    throw std::runtime_error("unsupported-brep-surface");
  o << "{\"dimension\":3,\"degree\":[" << n.Degree(0) << ',' << n.Degree(1)
    << "],\"rational\":" << (n.m_is_rat?"true":"false") << ",\"parameterization\":" << accuracy
    << ",\"closed\":[" << (source.IsClosed(0)?"true":"false") << ',' << (source.IsClosed(1)?"true":"false")
    << "],\"periodic\":[" << (source.IsPeriodic(0)?"true":"false") << ',' << (source.IsPeriodic(1)?"true":"false") << ']'
    << ",\"controlPointEncoding\":\"" << (n.m_is_rat?"homogeneous":"euclidean")
    << "\",\"knotConvention\":\"full-openNURBS-end-duplicated\",\"domain\":["; interval(o,source.Domain(0)); o << ','; interval(o,source.Domain(1));
  o << "],\"knots\":[";
  for(int dir=0;dir<2;++dir) {
    if(dir) o << ','; o << '['; const int count=n.m_order[dir]+n.m_cv_count[dir]-2;
    number(o,n.m_knot[dir][0]);
    for(int i=0;i<count;++i) { o << ','; number(o,n.m_knot[dir][i]); }
    o << ','; number(o,n.m_knot[dir][count-1]);
    o << ']';
  }
  o << "],\"controlPointCount\":[" << n.m_cv_count[0] << ',' << n.m_cv_count[1] << "],\"controlPoints\":[";
  bool first=true;
  for(int v=0;v<n.m_cv_count[1];++v) for(int u=0;u<n.m_cv_count[0];++u) {
    if(!first) o << ','; first=false; const double* cv=n.CV(u,v); o << '[';
    for(int j=0;j<n.CVSize();++j) { if(j) o << ','; number(o,cv[j]); }
    o << ']';
  }
  o << "],\"parameterMap\":"; surfaceParameterMap(o,source,accuracy);
  if(accuracy==2) { o << ",\"parameterEvidence\":"; surfaceParameterEvidence(o,source); }
  o << '}';
}
static void cadIr(std::ostream& o, const ON_Brep& b) {
  if(!b.IsValid()) throw std::runtime_error("invalid-brep");
  o << "{\"schemaVersion\":1,\"representation\":\"trimmed-nurbs-brep\",\"vertices\":[";
  for(int i=0;i<b.m_V.Count();++i) {
    if(i) o << ','; const auto& vertex=b.m_V[i]; const auto p=vertex.Point(); o << "{\"point\":[";
    number(o,p.x); o << ','; number(o,p.y); o << ','; number(o,p.z); o << "],\"tolerance\":";
    tolerance(o,vertex.m_tolerance); o << '}';
  }
  o << "],\"curves3d\":[";
  for(int i=0;i<b.m_C3.Count();++i) {
    if(i) o << ','; if(!b.m_C3[i]) throw std::runtime_error("missing-brep-curve3d"); nurbsCurve(o,*b.m_C3[i]);
  }
  o << "],\"curves2d\":[";
  for(int i=0;i<b.m_C2.Count();++i) {
    if(i) o << ','; if(!b.m_C2[i]) throw std::runtime_error("missing-brep-curve2d"); nurbsCurve(o,*b.m_C2[i]);
  }
  o << "],\"surfaces\":[";
  for(int i=0;i<b.m_S.Count();++i) {
    if(i) o << ','; if(!b.m_S[i]) throw std::runtime_error("missing-brep-surface"); nurbsSurface(o,*b.m_S[i]);
  }
  o << "],\"edges\":[";
  for(int i=0;i<b.m_E.Count();++i) {
    const auto& e=b.m_E[i];
    if(e.m_c3i<0 || e.m_c3i>=b.m_C3.Count() || e.m_vi[0]<0 || e.m_vi[0]>=b.m_V.Count() || e.m_vi[1]<0 || e.m_vi[1]>=b.m_V.Count())
      throw std::runtime_error("invalid-brep-edge-reference");
    if(i) o << ','; o << "{\"curve3d\":" << e.m_c3i << ",\"vertices\":[" << e.m_vi[0] << ',' << e.m_vi[1]
      << "],\"curveReversed\":" << (e.ProxyCurveIsReversed()?"true":"false") << ",\"domain\":"; interval(o,e.Domain());
    o << ",\"sourceSubdomain\":"; interval(o,e.ProxyCurveDomain()); o << ",\"tolerance\":"; tolerance(o,e.m_tolerance); o << '}';
  }
  o << "],\"trims\":[";
  for(int i=0;i<b.m_T.Count();++i) {
    const auto& t=b.m_T[i];
    if(t.m_c2i<0 || t.m_c2i>=b.m_C2.Count() || t.m_li<0 || t.m_li>=b.m_L.Count()
      || (t.m_ei>=b.m_E.Count()) || t.m_ei<-1) throw std::runtime_error("invalid-brep-trim-reference");
    if(i) o << ','; o << "{\"curve2d\":" << t.m_c2i << ",\"edge\":" << t.m_ei
      << ",\"loop\":" << t.m_li << ",\"reverse3d\":" << (t.m_bRev3d?"true":"false")
      << ",\"curveReversed\":" << (t.ProxyCurveIsReversed()?"true":"false")
      << ",\"type\":" << (int)t.m_type << ",\"iso\":" << (int)t.m_iso << ",\"domain\":";
    interval(o,t.Domain()); o << ",\"sourceSubdomain\":"; interval(o,t.ProxyCurveDomain());
    o << ",\"tolerance\":["; tolerance(o,t.m_tolerance[0]); o << ','; tolerance(o,t.m_tolerance[1]); o << "]}";
  }
  o << "],\"loops\":[";
  for(int i=0;i<b.m_L.Count();++i) {
    const auto& l=b.m_L[i]; if(l.m_fi<0 || l.m_fi>=b.m_F.Count()) throw std::runtime_error("invalid-brep-loop-face");
    if(i) o << ','; o << "{\"face\":" << l.m_fi << ",\"type\":" << (int)l.m_type << ",\"trims\":[";
    for(int j=0;j<l.m_ti.Count();++j) {
      const int ti=l.m_ti[j]; if(ti<0 || ti>=b.m_T.Count() || b.m_T[ti].m_li!=i) throw std::runtime_error("invalid-brep-loop-trim");
      if(j) o << ','; o << ti;
    }
    o << "]}";
  }
  o << "],\"faces\":[";
  for(int i=0;i<b.m_F.Count();++i) {
    const auto& f=b.m_F[i]; if(f.m_si<0 || f.m_si>=b.m_S.Count()) throw std::runtime_error("invalid-brep-face-surface");
    if(i) o << ','; o << "{\"surface\":" << f.m_si << ",\"reversed\":" << (f.m_bRev?"true":"false") << ",\"loops\":[";
    for(int j=0;j<f.m_li.Count();++j) {
      const int li=f.m_li[j]; if(li<0 || li>=b.m_L.Count() || b.m_L[li].m_fi!=i) throw std::runtime_error("invalid-brep-face-loop");
      if(j) o << ','; o << li;
    }
    o << "]}";
  }
  o << "]}";
}
static void material(std::ostream& o, const ON_Material& m) {
  ON_String name(m.Name());
  o << "{\"id\":" << id(m.Id()) << ",\"index\":" << m.Index() << ",\"name\":" << quoted(name.Array())
    << ",\"legacyDiffuseRgb\":[" << m.m_diffuse.Red() << ',' << m.m_diffuse.Green() << ',' << m.m_diffuse.Blue() << "],\"textures\":[";
  for(int i=0;i<m.m_textures.Count();++i) {
    if(i) o << ','; const auto& t=m.m_textures[i];
    ON_String full(t.m_image_file_reference.FullPath()), relative(t.m_image_file_reference.RelativePath());
    o << "{\"id\":" << id(t.m_texture_id) << ",\"type\":" << (unsigned)t.m_type
      << ",\"enabled\":" << (t.m_bOn?"true":"false") << ",\"mappingChannelId\":" << t.m_mapping_channel_id
      << ",\"fullPath\":" << quoted(full.Array()) << ",\"relativePath\":" << quoted(relative.Array())
      << ",\"wrapU\":" << (unsigned)t.m_wrapu << ",\"wrapV\":" << (unsigned)t.m_wrapv << ",\"uvwRowMajor\":[";
    for(int r=0;r<4;++r) for(int c=0;c<4;++c) { if(r||c) o << ','; number(o,t.m_uvw[r][c]); }
    o << "]}";
  }
  o << "]}";
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
    o << ",\"kind\":\"brep\",\"faceCount\":" << b->m_F.Count() << ",\"cadIr\":"; cadIr(o,*b);
    o << ",\"storedRenderMeshes\":[";
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
    if(!first) o << ','; first=false; material(o,*m);
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
